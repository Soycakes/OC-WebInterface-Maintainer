local component = require("component")
local computer = require("computer")
local event = require("event")
local serialization = require("serialization")
local ae2 = require("src.ae2")
local cfg = require("config")

local tunnel = component.tunnel

local items = cfg.items or {}
local fluids = cfg.fluids or {}

if fluids and next(fluids) and not ae2.hasFluidSupport() then
  print("WARNING: fluids configured but ME interface does not support getFluidInNetwork (needs GTNH 2.9+). Fluids skipped.")
  fluids = {}
end

local catalogCache = nil
local catalogTime = 0
local CATALOG_TTL = 300

local function log(msg)
  print("[" .. os.date("%H:%M:%S") .. "] " .. tostring(msg))
end

local function catalog()
  local now = os.time()
  if catalogCache and now - catalogTime < CATALOG_TTL then return catalogCache end
  local craftables = component.me_interface.getCraftables()
  local labels = {}
  for i = 1, #craftables do
    local stack = (craftables[i].getStack or craftables[i].getItemStack)(craftables[i])
    if stack and stack.label then labels[#labels + 1] = stack.label end
  end
  catalogCache = labels
  catalogTime = now
  return labels
end

local function stock()
  local counts = {}
  for label, config in pairs(items) do
    counts[label] = ae2.getCount(label, config[3])
  end
  for label, config in pairs(fluids) do
    counts[label] = ae2.getCount(label, config[3] or label)
  end
  return counts
end

local function handleModem(_, _, _, _, _, msg)
  if msg == "requeststock" then
    tunnel.send(serialization.serialize({ stock = stock() }))
    return
  end
  if msg == "requestcatalog" then
    tunnel.send(serialization.serialize({ catalog = catalog() }))
    return
  end
  local data = serialization.unserialize(msg)
  if type(data) ~= "table" or not data.targets then return end
  items = {}
  fluids = {}
  for _, t in ipairs(data.targets) do
    if t.is_fluid == 1 then
      fluids[t.label] = { t.threshold, t.batch_size, t.fluid_tag }
    else
      items[t.label] = { t.threshold, t.batch_size, t.fluid_tag }
    end
  end
  ae2.clearCache()
  log("targets updated from web")
end

while true do
  local deadline = computer.uptime() + (cfg.sleep or 5)

  while computer.uptime() < deadline do
    local remaining = deadline - computer.uptime()
    local _, _, _, _, _, msg = event.pull(remaining, "modem_message")
    if msg then handleModem(nil, nil, nil, nil, nil, msg) end
  end

  local active = ae2.crafting()

  for label, config in pairs(items) do
    if active[label] then
      log(label .. " already crafting, skipping")
    else
      local _, msg = ae2.requestItem(label, config[1], config[2], config[3])
      log(msg)
    end
  end

  for label, config in pairs(fluids) do
    if active[label] then
      log(label .. " already crafting, skipping")
    else
      local _, msg = ae2.requestFluid(label, config[1], config[2], config[3])
      log(msg)
    end
  end
end
