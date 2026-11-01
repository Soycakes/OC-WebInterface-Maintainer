local component = require("component")
local computer = require("computer")
local event = require("event")
local serialization = require("serialization")
local ae2 = require("src.ae2")
local cfg = require("config")

local tunnel = component.tunnel

local items = cfg.items or {}
local fluids = cfg.fluids or {}
local currentSleep = cfg.sleep or 5
local debugEnabled = cfg.debug == true

if fluids and next(fluids) and not ae2.hasFluidSupport() then
  print("WARNING: fluids configured but ME interface does not support getFluidsInNetwork (needs GTNH 2.9+). Fluids skipped.")
  fluids = {}
end

local lastCycleStatus = { crafting = {}, requested = {}, failed = {} }
local cachedStock = {}
local serializedStockCache = ""

local gpu = component.isAvailable("gpu") and component.gpu or nil
local screenW, screenH = 50, 16
if gpu then screenW, screenH = gpu.getResolution() end

local logBuffer = {}

local function log(msg)
  local line = "[" .. os.date("%H:%M:%S") .. "] " .. tostring(msg)
  if gpu then
    logBuffer[#logBuffer + 1] = line
    if #logBuffer > 6 then table.remove(logBuffer, 1) end
  else
    print(line)
  end
end

local function drawScreen(active, requested, failed, queryTime, qCount)
  if not gpu then return end
  gpu.fill(1, 1, screenW, screenH, " ")
  local row = 1
  local maxRow = screenH - 1
  local function line(text, color)
    if row > maxRow then return end
    gpu.setForeground(color or 0xFFFFFF)
    gpu.set(1, row, text)
    row = row + 1
  end
  local managedCrafting = false
  for label, count in pairs(active) do
    if items[label] or fluids[label] then
      if not managedCrafting then
        line("CURRENTLY CRAFTING", 0x55FFFF)
        managedCrafting = true
      end
      line("  " .. label .. " : " .. count .. "x", 0x55FFFF)
    end
  end
  if managedCrafting then line("---", 0x555555) end
  for label, batch in pairs(requested) do
    line("  requested " .. label .. " x " .. batch, 0x55FF55)
  end
  for label in pairs(lastCycleStatus.held or {}) do
    line("  held " .. label, 0xFFAA00)
  end
  for _, msg in pairs(failed) do
    line("  " .. msg, 0xFF2020)
  end
  for _, entry in ipairs(logBuffer) do
    line(entry, 0x888888)
  end
  gpu.setForeground(0x777777)
  local statusLine = os.date("%H:%M:%S")
  if queryTime then
    local ticks = math.floor(queryTime / 0.05 + 0.5)
    local countStr = qCount and (" (" .. qCount .. " ME calls)") or ""
    statusLine = statusLine .. "  Query: " .. string.format("%.2fs", queryTime) .. " (" .. ticks .. "t)" .. countStr
  end
  gpu.set(1, screenH, statusLine)
  gpu.setForeground(0xFFFFFF)
end


local function stock()
  local itemCounts = ae2.getItemCounts()
  local fluidCounts
  local function fluidCount(label)
    fluidCounts = fluidCounts or ae2.getFluidCounts()
    return fluidCounts[label] or 0
  end
  local counts = {}
  for label in pairs(items) do
    counts[label] = itemCounts[label] or 0
  end
  for label in pairs(fluids) do
    counts[label] = fluidCount(label)
  end
  for _, list in ipairs({ items, fluids }) do
    for _, config in pairs(list) do
      for _, rule in ipairs(config[4] and config[4].rules or {}) do
        if counts[rule.label] == nil then
          counts[rule.label] = rule.is_fluid and fluidCount(rule.label) or itemCounts[rule.label] or 0
        end
      end
    end
  end
  return counts
end

local function emitterOn(emitter, counts)
  local any, all = false, true
  for _, rule in ipairs(emitter.rules) do
    local count = counts[rule.label] or 0
    local met
    if rule.below then met = count < rule.amount else met = count >= rule.amount end
    any = any or met
    all = all and met
  end
  if emitter.mode == "or" then return any end
  return all
end

local function handleModem(_, _, _, _, _, msg)
  if msg == "requeststock" then
    tunnel.send(serializedStockCache)
    return
  end
if msg:sub(1, 8) == "setsleep" then
    local n = tonumber(msg:sub(10))
    if n and n >= 5 then
      currentSleep = n
      log("sleep set to " .. n .. "s")
    end
    return
  end
  local data = serialization.unserialize(msg)
  if type(data) ~= "table" or not data.targets then return end
  items = {}
  fluids = {}
  for _, t in ipairs(data.targets) do
    if t.is_fluid == 1 then
      fluids[t.label] = { t.threshold, t.batch_size, t.fluid_tag, t.emitter }
    else
      items[t.label] = { t.threshold, t.batch_size, t.fluid_tag, t.emitter }
    end
  end
  ae2.forgetMissing()
  log("targets updated from web")
end

local function mainLoop()
  cachedStock = stock()
  serializedStockCache = serialization.serialize({ stock = cachedStock, status = lastCycleStatus })
  event.listen("modem_message", handleModem)
  while true do
    os.sleep(currentSleep)

    if debugEnabled then ae2.resetQueryCount() end
    local startTime = debugEnabled and computer.uptime() or nil
    cachedStock = stock()
    local active = ae2.crafting()
    local cycleRequested = {}
    local cycleFailed = {}
    local cycleHeld = {}
    local emitterStates = {}
    for _, list in ipairs({ items, fluids }) do
      for label, config in pairs(list) do
        if config[4] then emitterStates[label] = emitterOn(config[4], cachedStock) end
      end
    end
    local function held(label, config)
      if emitterStates[label] ~= false then return false end
      if config[1] ~= nil and (cachedStock[label] or 0) >= config[1] then return false end
      cycleHeld[label] = true
      return true
    end

    for label, config in pairs(items) do
      if not active[label] and not held(label, config) then
        local ok, msg = ae2.request(label, config[1], config[2], cachedStock[label], "")
        if ok then
          cycleRequested[label] = config[2] or 1
          ae2.clearCraftingCache()
        elseif msg then
          cycleFailed[label] = msg
        end
      end
    end

    for label, config in pairs(fluids) do
      if not active[label] and not held(label, config) then
        local ok, msg = ae2.request(label, config[1], config[2], cachedStock[label], " mB")
        if ok then
          cycleRequested[label] = config[2] or 1
          ae2.clearCraftingCache()
        elseif msg then
          cycleFailed[label] = msg
        end
      end
    end

    local managedActive = {}
    for label, count in pairs(active) do
      if items[label] or fluids[label] then managedActive[label] = count end
    end
    lastCycleStatus = { crafting = managedActive, requested = cycleRequested, failed = cycleFailed, held = cycleHeld, emitter = emitterStates }
    serializedStockCache = serialization.serialize({ stock = cachedStock, status = lastCycleStatus })
    local queryTime = debugEnabled and (computer.uptime() - startTime) or nil
    local qCount = debugEnabled and ae2.getQueryCount() or nil
    drawScreen(active, cycleRequested, cycleFailed, queryTime, qCount)
    logBuffer = {}
  end
end

local ok, err = pcall(mainLoop)
event.ignore("modem_message", handleModem)
if not ok then
  print("Stopped: " .. tostring(err))
end
