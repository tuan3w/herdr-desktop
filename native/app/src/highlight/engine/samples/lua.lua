-- A tiny ledger.
local M = {}
local MAX_ENTRIES <const> = 1024

---@class Entry
---@field name string
---@field cents integer

--[[ TODO: persist
     to disk ]]
function M.new(limit)
  local self = setmetatable({ items = {}, limit = limit or MAX_ENTRIES }, { __index = M })
  return self
end

function M:put(entry)
  local list = self.items[entry.name] or {}
  if #list >= self.limit then
    return nil, ("full: %s"):format(entry.name)
  end
  list[#list + 1] = entry
  self.items[entry.name] = list
  return true
end

function M:balance(name)
  local sum = 0
  for _, e in ipairs(self.items[name] or {}) do
    sum = sum + e.cents
  end
  return sum
end

local function each(rows, fn, ...)
  for i = 1, #rows do
    fn(rows[i], ...)
  end
end

local Report = setmetatable({}, { __call = function(cls, rows) return cls end })
local book = M.new()
book:put({ name = "acme", cents = 1500 })
print("balance:", book:balance("acme"), "\t", #"acme", 0x1F, 3.14)
each({ book }, function(b) print(string.format("%s", b.limit)) end)
goto done
::done::
