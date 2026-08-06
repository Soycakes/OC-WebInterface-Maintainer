local json = {}

local function encode_value(val)
  local t = type(val)
  if t == "nil" then return "null"
  elseif t == "boolean" then return tostring(val)
  elseif t == "number" then return tostring(val)
  elseif t == "string" then
    return '"' .. val:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t') .. '"'
  elseif t == "table" then
    local isArray = #val > 0
    if isArray then
      local parts = {}
      for i = 1, #val do parts[i] = encode_value(val[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    else
      local parts = {}
      for k, v in pairs(val) do
        parts[#parts + 1] = '"' .. tostring(k) .. '":' .. encode_value(v)
      end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  end
  return "null"
end

function json.encode(val)
  return encode_value(val)
end

local function skip(s, i)
  while i <= #s and s:sub(i, i):match("%s") do i = i + 1 end
  return i
end

local decode_value

local function decode_string(s, i)
  i = i + 1
  local buf = {}
  while i <= #s do
    local c = s:sub(i, i)
    if c == '"' then return table.concat(buf), i + 1 end
    if c == '\\' then
      i = i + 1; c = s:sub(i, i)
      if c == 'n' then buf[#buf+1] = '\n'
      elseif c == 't' then buf[#buf+1] = '\t'
      elseif c == 'r' then buf[#buf+1] = '\r'
      else buf[#buf+1] = c end
    else
      buf[#buf+1] = c
    end
    i = i + 1
  end
  error("unterminated string")
end

local function decode_array(s, i)
  i = skip(s, i + 1)
  local t = {}
  if s:sub(i, i) == "]" then return t, i + 1 end
  while true do
    local v; v, i = decode_value(s, i)
    t[#t+1] = v
    i = skip(s, i)
    if s:sub(i, i) == "]" then return t, i + 1 end
    i = skip(s, i + 1)
  end
end

local function decode_object(s, i)
  i = skip(s, i + 1)
  local t = {}
  if s:sub(i, i) == "}" then return t, i + 1 end
  while true do
    i = skip(s, i)
    local k; k, i = decode_string(s, i)
    i = skip(s, i + 1) -- skip :
    local v; v, i = decode_value(s, i)
    t[k] = v
    i = skip(s, i)
    if s:sub(i, i) == "}" then return t, i + 1 end
    i = skip(s, i + 1)
  end
end

decode_value = function(s, i)
  i = skip(s, i)
  local c = s:sub(i, i)
  if c == '"' then return decode_string(s, i)
  elseif c == '[' then return decode_array(s, i)
  elseif c == '{' then return decode_object(s, i)
  elseif c == 't' then return true, i + 4
  elseif c == 'f' then return false, i + 5
  elseif c == 'n' then return nil, i + 4
  else
    local num, j = s:match("^(-?%d+%.?%d*[eE]?[+-]?%d*)()", i)
    return tonumber(num), j
  end
end

function json.decode(s)
  return (decode_value(s, 1))
end

return json
