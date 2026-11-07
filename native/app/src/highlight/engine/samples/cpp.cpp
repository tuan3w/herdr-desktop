#include <algorithm>
#include <iostream>
#include <map>
#include <memory>
#include <string_view>
#include <vector>

namespace ledger {

constexpr std::size_t kMaxEntries = 1'024;

/// One posting on an account.
struct Entry {
    std::string name;
    long cents = 0;
};

template <typename T>
concept Postable = requires(T t) { { t.cents } -> std::convertible_to<long>; };

class Ledger {
public:
    explicit Ledger(std::size_t limit = kMaxEntries) : limit_{limit} {}

    // TODO: return an expected<void, Error>
    [[nodiscard]] bool put(Entry entry) {
        auto &list = items_[entry.name];
        if (list.size() >= limit_) return false;
        list.push_back(std::move(entry));
        return true;
    }

    template <Postable T>
    static long sum(const std::vector<T> &rows) {
        return std::accumulate(rows.begin(), rows.end(), 0L,
                               [](long acc, const T &r) { return acc + r.cents; });
    }

    long balance(std::string_view name) const {
        auto it = items_.find(std::string{name});
        return it == items_.end() ? 0 : sum(it->second);
    }

private:
    std::size_t limit_;
    std::map<std::string, std::vector<Entry>> items_;
};

}  // namespace ledger

int main() {
    auto book = std::make_unique<ledger::Ledger>();
    book->put({"acme", 1'500});
    std::cout << "balance: " << book->balance("acme") << R"(
raw line)" << '\n';
}
