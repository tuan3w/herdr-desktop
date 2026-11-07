package dev.example.ledger;

import java.time.Duration;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Keeps a balance per account.
 *
 * @param <T> the entry type
 */
@SuppressWarnings("unchecked")
public final class Ledger<T extends Ledger.Entry> implements Iterable<T> {
    public static final int MAX_ENTRIES = 1_024;
    private static final String PREFIX = "acct\t";

    public sealed interface Entry permits Credit, Debit {}
    public record Credit(String name, long cents) implements Entry {}
    public record Debit(String name, long cents, String memo) implements Entry {}

    private final Map<String, List<T>> items = new HashMap<>();
    private volatile Duration lag = Duration.ZERO;

    @Override
    public Iterator<T> iterator() {
        return items.values().stream().flatMap(List::stream).iterator();
    }

    /** Adds an entry or throws when the account is full. */
    public synchronized void put(String name, T entry) throws IllegalStateException {
        // TODO: reject duplicates
        List<T> list = items.computeIfAbsent(name, k -> new ArrayList<>());
        if (list.size() >= MAX_ENTRIES) {
            throw new IllegalStateException("full: " + name);
        }
        list.add(entry);
    }

    public long balance(String name) {
        return items.getOrDefault(name, List.of()).stream()
            .mapToLong(e -> e instanceof Credit c ? c.cents() : -((Debit) e).cents())
            .sum();
    }

    public static void main(String[] args) {
        var ledger = new Ledger<Entry>();
        ledger.put("acme", new Credit("acme", 1_500L));
        var names = ledger.items.keySet().stream().sorted().collect(Collectors.joining(", "));
        System.out.println("accounts: " + names + (args.length > 0 ? "!" : ""));
    }
}

enum Level {
    LOW, HIGH;
    boolean urgent() { return this == HIGH; }
}
