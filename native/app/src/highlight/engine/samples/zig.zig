//! A tiny ledger.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const max_entries = 1024;

/// One posting on an account.
pub const Entry = struct {
    name: []const u8,
    cents: i64,
};

pub const Error = error{ Full, OutOfMemory };

pub const Ledger = struct {
    gpa: Allocator,
    items: std.StringHashMap(std.ArrayList(Entry)),

    pub fn init(gpa: Allocator) Ledger {
        return .{ .gpa = gpa, .items = std.StringHashMap(std.ArrayList(Entry)).init(gpa) };
    }

    // TODO: free the lists in deinit
    pub fn put(self: *Ledger, entry: Entry) Error!void {
        const slot = try self.items.getOrPut(entry.name);
        if (!slot.found_existing) slot.value_ptr.* = std.ArrayList(Entry).init(self.gpa);
        if (slot.value_ptr.items.len >= max_entries) return error.Full;
        try slot.value_ptr.append(entry);
    }

    pub fn balance(self: *const Ledger, name: []const u8) i64 {
        var sum: i64 = 0;
        const list = self.items.get(name) orelse return 0;
        for (list.items) |e| sum += e.cents;
        return sum;
    }
};

pub const Kind = enum(u8) { credit, debit = 2, void_ };

fn Pair(comptime T: type) type {
    return struct { a: T, b: T };
}

fn describe(kind: Kind) []const u8 {
    return switch (kind) {
        .credit => "in",
        .debit, .void_ => "out",
    };
}

test "balance adds up" {
    var book = Ledger.init(std.testing.allocator);
    try book.put(.{ .name = "acme", .cents = 1_500 });
    try std.testing.expectEqual(@as(i64, 1500), book.balance("acme"));
    const opt: ?u32 = null;
    if (opt) |n| std.debug.print("{d}\n", .{n}) else std.debug.print("none\n", .{});
    std.debug.print("ok \"{s}\"\n", .{"acme"});
}
