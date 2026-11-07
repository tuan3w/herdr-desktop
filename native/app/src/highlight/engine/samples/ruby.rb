# frozen_string_literal: true

require "json"
require "set"

module Ledger
  MAX_ENTRIES = 1_024
  PATTERN = /\A(?<name>\w+)\s+(?<cents>-?\d+)\z/

  # One posting on an account.
  Entry = Struct.new(:name, :cents, keyword_init: true) do
    def credit? = cents >= 0
  end

  class Full < StandardError
    def initialize(name) = super("full: #{name}")
  end

  class Book
    include Enumerable
    attr_reader :items

    def initialize(limit: MAX_ENTRIES)
      @limit = limit
      @items = Hash.new { |h, k| h[k] = [] }
    end

    # TODO: make this thread safe
    def put(entry)
      raise Full, entry.name if @items[entry.name].size >= @limit

      @items[entry.name] << entry
      self
    end

    def each(&block)
      return enum_for(:each) unless block_given?

      @items.values.flatten.each(&block)
    end

    def balance(name) = @items.fetch(name, []).sum(&:cents)
  end
end

book = Ledger::Book.new
book.put(Ledger::Entry.new(name: "acme", cents: 1_500))
puts "balance: #{book.balance("acme")}\t#{:ok.inspect}"
%w[a b c].each_with_index { |s, i| puts "#{i}: #{s}" if i.positive? }

def report(entries, sep: ", ", &fmt)
  total = entries.sum(&:cents)
  summary = <<~TEXT
    #{entries.size} entries, total #{total}
  TEXT
  case total
  in Integer => n if n.zero? then puts "empty"
  in 1.. then puts summary.strip.split(sep).map(&fmt).join
  else raise ArgumentError, "negative: #{total}"
  end
rescue Ledger::Full => e
  warn e.message
ensure
  @reported = true
end
