local json = {}

local function skipws(s, i)
  while i <= #s and s:sub(i, i):match("%s") do i = i + 1 end
  return i
end

local function parseValue(s, i)
  i = skipws(s, i)
  local c = s:sub(i, i)
  if c == '"' then
    local j = i + 1
    local out = {}
    while j <= #s do
      local ch = s:sub(j, j)
      if ch == '\\' then
        local esc = s:sub(j + 1, j + 1)
        if esc == 'n' then out[#out + 1] = '\n'
        elseif esc == 'r' then out[#out + 1] = '\r'
        elseif esc == 't' then out[#out + 1] = '\t'
        else out[#out + 1] = esc end
        j = j + 2
      elseif ch == '"' then
        return table.concat(out), j + 1
      else
        out[#out + 1] = ch
        j = j + 1
      end
    end
    error("unterminated string")
  elseif c == '{' then
    local obj = {}
    i = skipws(s, i + 1)
    if s:sub(i, i) == '}' then return obj, i + 1 end
    while true do
      i = skipws(s, i)
      local key, ni = parseValue(s, i)
      i = skipws(s, ni)
      i = i + 1
      i = skipws(s, i)
      local val, ni2 = parseValue(s, i)
      obj[key] = val
      i = skipws(s, ni2)
      if s:sub(i, i) == '}' then return obj, i + 1 end
      i = i + 1
    end
  elseif c == '[' then
    local arr = {}
    i = skipws(s, i + 1)
    if s:sub(i, i) == ']' then return arr, i + 1 end
    while true do
      i = skipws(s, i)
      local val, ni = parseValue(s, i)
      arr[#arr + 1] = val
      i = skipws(s, ni)
      if s:sub(i, i) == ']' then return arr, i + 1 end
      i = i + 1
    end
  elseif s:sub(i, i + 3) == 'null' then
    return nil, i + 4
  elseif s:sub(i, i + 3) == 'true' then
    return true, i + 4
  elseif s:sub(i, i + 4) == 'false' then
    return false, i + 5
  else
    local num = s:match("^-?%d+%.?%d*", i)
    if num then return tonumber(num), i + #num end
    error("unexpected character at position " .. i .. ": " .. c)
  end
end

function json.encode(val)
  local t = type(val)
  if val == nil then return "null" end
  if t == "boolean" then return val and "true" or "false" end
  if t == "number" then return tostring(val) end
  if t == "string" then
    return '"' .. val:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n') .. '"'
  end
  if t == "table" then
    if #val > 0 then
      local parts = {}
      for i = 1, #val do parts[i] = json.encode(val[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    else
      local parts = {}
      for k, v in pairs(val) do
        if type(k) == "string" then
          parts[#parts + 1] = '"' .. k .. '":' .. json.encode(v)
        end
      end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  end
  return "null"
end

function json.decode(s)
  local val = parseValue(s, 1)
  return val
end

return json
