import Foundation

/// One posting on an account.
struct Entry: Codable, Equatable {
    let name: String
    var cents: Int
    var memo: String? = nil
}

enum LedgerError: Error {
    case full(limit: Int)
    case unknown(String)
}

protocol Store: AnyObject {
    func put(_ entry: Entry) throws
    func balance(of name: String) -> Int
}

@MainActor
final class Ledger: Store, ObservableObject {
    static let maxEntries = 1_024
    @Published private(set) var items: [String: [Entry]] = [:]

    // TODO: persist to disk
    func put(_ entry: Entry) throws {
        var list = items[entry.name, default: []]
        guard list.count < Self.maxEntries else {
            throw LedgerError.full(limit: Self.maxEntries)
        }
        list.append(entry)
        items[entry.name] = list
    }

    func balance(of name: String) -> Int {
        items[name]?.reduce(0) { $0 + $1.cents } ?? 0
    }
}

extension Ledger {
    func report() async -> String {
        let names = items.keys.sorted()
        return names.map { "\($0): \(balance(of: $0))" }.joined(separator: "\n")
    }
}

let book = Ledger()
Task {
    do {
        try await book.put(Entry(name: "acme", cents: 1_500))
        print(await book.report())
    } catch let error as LedgerError {
        print("failed: \(error)")
    }
}
