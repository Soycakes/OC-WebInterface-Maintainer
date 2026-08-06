local component = require("component")
local internet = require("internet")
local modem = component.modem
local serialization = require("serialization")

local config = {
  server = "http://127.0.0.1:3000",
  api_key = "change_this_to_match_your_env",
  network_id = "main",
  poll_interval = 5,
  modem_port = 321
}

modem.open(config.modem_port)

local function post(path, body)
  local url = config.server .. path
  local data = serialization.serialize(body)
  local response = internet.request(url, data, {
    ["Content-Type"] = "application/json",
    ["Authorization"] = "Bearer " .. config.api_key
  })
  local result = ""
  for chunk in response do result = result .. chunk end
  return serialization.unserialize(result)
end

local function sync(stock, catalog)
  local ok, result = pcall(post, "/api/sync", {
    network_id = config.network_id,
    stock = stock,
    catalog = catalog
  })
  if not ok then return nil end
  return result
end

while true do
  -- ask maintainer for current stock and catalog via modem
  modem.broadcast(config.modem_port, "requeststock")

  local _, _, _, _, _, msg = event.pull(3, "modem_message")
  if msg then
    local data = serialization.unserialize(msg)
    local result = sync(data.stock, data.catalog)
    if result and result.targets then
      modem.broadcast(config.modem_port, serialization.serialize({ targets = result.targets }))
    end
  end

  os.sleep(config.poll_interval)
end
