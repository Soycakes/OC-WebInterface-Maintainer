local component = require("component")
local computer = require("computer")
local ME = component.me_interface

local ae2 = {}

local craftableCache = {}
local cacheTime = 0
local CACHE_TTL = 600

local craftingCache = nil
local craftingCacheTime = 0
local CRAFTING_CACHE_TTL = 30

local queryCount = 0

function ae2.getQueryCount()
  return queryCount
end

function ae2.resetQueryCount()
  queryCount = 0
end

local function getCraftable(name)
  local now = computer.uptime()
  if now - cacheTime >= CACHE_TTL then
    craftableCache = {}
    cacheTime = now
  end
  local cached = craftableCache[name]
  if cached == nil then
    queryCount = queryCount + 1
    cached = ME.getCraftables({ ["label"] = name })[1] or false
    craftableCache[name] = cached
  end
  return cached or nil
end

function ae2.forgetMissing()
  for name, cached in pairs(craftableCache) do
    if not cached then craftableCache[name] = nil end
  end
end

function ae2.getItemCounts()
  queryCount = queryCount + 1
  local counts, craftable = {}, {}
  for _, item in ipairs(ME.getItemsInNetwork()) do
    local label = item.label
    if label and (counts[label] == nil or item.isCraftable and not craftable[label]) then
      counts[label] = item.size or 0
      craftable[label] = item.isCraftable
    end
  end
  return counts
end

function ae2.getFluidCounts()
  local counts = {}
  if not ME.getFluidsInNetwork then return counts end
  queryCount = queryCount + 1
  for _, fluid in ipairs(ME.getFluidsInNetwork()) do
    if fluid.label then counts[fluid.label] = (counts[fluid.label] or 0) + (fluid.amount or fluid.size or 0) end
  end
  return counts
end

function ae2.request(name, threshold, batch, count, unit)
  if threshold ~= nil and count >= threshold then return end
  local craftable = getCraftable(name)
  if not craftable then
    return false, name .. " is not craftable"
  end
  queryCount = queryCount + 1
  local craft = craftable.request(batch)
  while craft.isComputing() do os.sleep(1) end
  if craft.hasFailed() then
    return false, "failed to request " .. name .. " x " .. batch .. unit
  end
  return true, "requested " .. name .. " x " .. batch .. unit
end

function ae2.crafting()
  local now = computer.uptime()
  if not craftingCache or now - craftingCacheTime >= CRAFTING_CACHE_TTL then
    queryCount = queryCount + 1
    local cpus = ME.getCpus()
    local active = {}
    for _, v in pairs(cpus) do
      if v.busy then
        queryCount = queryCount + 1
        local output = v.cpu.finalOutput()
        if output then active[output.label] = output.size or 1 end
      end
    end
    craftingCache = active
    craftingCacheTime = now
  end
  local copy = {}
  for k, v in pairs(craftingCache) do copy[k] = v end
  return copy
end

function ae2.clearCraftingCache()
  craftingCache = nil
  craftingCacheTime = 0
end

function ae2.hasFluidSupport()
  return ME.getFluidsInNetwork ~= nil
end

return ae2
