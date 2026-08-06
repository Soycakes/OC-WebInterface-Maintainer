local component = require("component")
local event = require("event")
local serialization = require("serialization")

local me = component.me_interface
local modem = component.modem

local config = {
  modem_port = 321,
  check_interval = 5
}

modem.open(config.modem_port)

-- targets keyed by label: { threshold, batch_size, fluid_tag }
local targets = {}

local function getStock()
  local stock = {}
  local catalog = {}
  for _, item in ipairs(me.getItemsInNetwork()) do
    local label = item.label
    stock[label] = item.size
    catalog[#catalog + 1] = label
  end
  return stock, catalog
end

local function maintain(stock)
  for label, target in pairs(targets) do
    local count = stock[label] or 0
    local threshold = target[1]
    local batch = target[2]
    if threshold == nil or count < threshold then
      me.requestCrafting({ label = label }, batch)
    end
  end
end

local function handleModem(_, _, _, _, _, msg)
  if msg == "requeststock" then
    local stock, catalog = getStock()
    modem.broadcast(config.modem_port, serialization.serialize({ stock = stock, catalog = catalog }))
    return
  end
  local data = serialization.unserialize(msg)
  if data and data.targets then
    targets = {}
    for _, t in ipairs(data.targets) do
      targets[t.label] = { t.threshold, t.batch_size, t.fluid_tag }
    end
  end
end

event.listen("modem_message", handleModem)

while true do
  local stock = getStock()
  maintain(stock)
  os.sleep(config.check_interval)
end
