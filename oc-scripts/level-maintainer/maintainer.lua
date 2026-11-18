local component = require("component")
local computer = require("computer")
local ae2 = require("src.ae2")
local json = require("src.json")
local cfg = require("config")

assert(cfg.server, "config.lua is missing server, api_key and network_id. Delete it and run install-maintainer again.")

local internet = component.internet

local items = {}
local fluids = {}
local currentSleep = 10
local debugEnabled = cfg.debug == true
local lastBody = nil

local lastCycleStatus = { crafting = {}, requested = {}, failed = {} }
local cachedStock = {}
local sentStock = {}

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
    statusLine = statusLine .. "  Query: " .. string.format("%.2fs", queryTime) .. " (" .. ticks .. "t)" .. countStr .. "  Free: " .. math.floor(computer.freeMemory() / 1024) .. "k"
  end
  gpu.set(1, screenH, statusLine)
  gpu.setForeground(0xFFFFFF)
end

local function post(path, body)
  local handle, reason = internet.request(cfg.server .. path, json.encode(body), {
    ["Content-Type"] = "application/json",
    ["Authorization"] = "Bearer " .. (cfg.api_key or ""),
  })
  if not handle then error(reason, 0) end
  local deadline = computer.uptime() + (cfg.timeout or 5)
  local chunks = {}
  local ok, err = pcall(function()
    while true do
      local chunk, readError = handle.read()
      if not chunk then
        if readError then error(readError, 0) end
        return
      end
      if chunk ~= "" then
        chunks[#chunks + 1] = chunk
      elseif computer.uptime() > deadline then
        error("timed out", 0)
      else
        os.sleep(0.05)
      end
    end
  end)
  handle.close()
  if not ok then error(err, 0) end
  return table.concat(chunks)
end

local function sync()
  local changes = {}
  for label, count in pairs(cachedStock) do
    if sentStock[label] ~= count then changes[label] = count end
  end
  local body = post("/api/sync", {
    network_id = cfg.network_id,
    stock = next(changes) and changes or nil,
    status = lastCycleStatus,
  })
  for label, count in pairs(changes) do sentStock[label] = count end
  if body == lastBody then return end
  local result = json.decode(body)
  if type(result) ~= "table" or type(result.targets) ~= "table" then
    error("bad response: " .. body:sub(1, 60), 0)
  end
  if result.resend_stock then sentStock = {} end
  lastBody = body
  items, fluids = {}, {}
  for _, t in ipairs(result.targets) do
    if t.is_fluid == 1 then fluids[t.label] = t else items[t.label] = t end
  end
  local sleep = tonumber(result.maintainer_sleep)
  if sleep and sleep >= 5 then currentSleep = sleep end
  ae2.forgetMissing()
  log("targets updated from web")
end

local function trySync()
  local ok, err = pcall(sync)
  if not ok then log("sync failed: " .. tostring(err)) end
end

local function stock()
  local itemLabels, fluidLabels = {}, {}
  for label in pairs(items) do itemLabels[label] = true end
  for label in pairs(fluids) do fluidLabels[label] = true end
  for _, list in ipairs({ items, fluids }) do
    for _, target in pairs(list) do
      for _, rule in ipairs(target.emitter and target.emitter.rules or {}) do
        if rule.is_fluid then fluidLabels[rule.label] = true else itemLabels[rule.label] = true end
      end
    end
  end
  local counts = ae2.getItemCounts(itemLabels)
  if next(fluidLabels) then
    local fluidCounts = ae2.getFluidCounts()
    for label in pairs(fluidLabels) do counts[label] = fluidCounts[label] or 0 end
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

local function cycle()
  if debugEnabled then ae2.resetQueryCount() end
  local startTime = debugEnabled and computer.uptime() or nil
  cachedStock = stock()
  local active = ae2.crafting()
  local cycleRequested = {}
  local cycleFailed = {}
  local cycleHeld = {}
  local emitterStates = {}
  for _, list in ipairs({ items, fluids }) do
    for label, target in pairs(list) do
      if target.emitter then emitterStates[label] = emitterOn(target.emitter, cachedStock) end
    end
  end
  local function held(label, target)
    if emitterStates[label] ~= false then return false end
    if target.threshold ~= nil and (cachedStock[label] or 0) >= target.threshold then return false end
    cycleHeld[label] = true
    return true
  end

  for _, kind in ipairs({ { items, "" }, { fluids, " mB" } }) do
    for label, target in pairs(kind[1]) do
      if not active[label] and not held(label, target) then
        local batch = target.batch_size or 1
        local ok, msg = ae2.request(label, target.threshold, batch, cachedStock[label], kind[2])
        if ok then
          cycleRequested[label] = batch
          ae2.clearCraftingCache()
        elseif msg then
          cycleFailed[label] = msg
        end
      end
    end
  end

  local managedActive = {}
  for label, count in pairs(active) do
    if items[label] or fluids[label] then managedActive[label] = count end
  end
  lastCycleStatus = { crafting = managedActive, requested = cycleRequested, failed = cycleFailed, held = cycleHeld, emitter = emitterStates }
  local queryTime = debugEnabled and (computer.uptime() - startTime) or nil
  local qCount = debugEnabled and ae2.getQueryCount() or nil
  trySync()
  drawScreen(active, cycleRequested, cycleFailed, queryTime, qCount)
  logBuffer = {}
end

local function mainLoop()
  trySync()
  while true do
    cycle()
    os.sleep(currentSleep)
  end
end

local ok, err = xpcall(mainLoop, debug.traceback)
if not ok then
  print("Stopped: " .. tostring(err))
end
