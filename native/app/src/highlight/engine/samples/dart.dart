import 'dart:async';
import 'package:meta/meta.dart';

const int maxEntries = 1024;

/// One posting on an account.
@immutable
class Entry {
  const Entry({required this.name, required this.cents, this.memo});

  final String name;
  final int cents;
  final String? memo;

  @override
  String toString() => 'Entry($name, $cents${memo == null ? '' : ', $memo'})';
}

enum Level { debug, info, warn }

abstract interface class Store {
  Future<void> put(Entry entry);
}

class Ledger implements Store {
  Ledger({this.limit = maxEntries});

  final int limit;
  final Map<String, List<Entry>> _items = {};

  // TODO: persist to disk
  @override
  Future<void> put(Entry entry) async {
    final list = _items.putIfAbsent(entry.name, () => []);
    if (list.length >= limit) {
      throw StateError('full: ${entry.name}');
    }
    list.add(entry);
  }

  int balance(String name) =>
      (_items[name] ?? const <Entry>[]).fold(0, (sum, e) => sum + e.cents);

  Stream<int> watch(String name) async* {
    while (true) {
      yield balance(name);
      await Future<void>.delayed(const Duration(seconds: 1));
    }
  }
}

Future<void> main() async {
  final book = Ledger();
  await book.put(const Entry(name: 'acme', cents: 1500, memo: r'raw \n'));
  print('balance: ${book.balance('acme')}');
}

mixin Logger on Store {
  void log(String message) => print('[$runtimeType] $message');
}

extension EntryX on Entry {
  bool get isCredit => cents >= 0;
}

String describe(Object? value) => switch (value) {
      int n when n < 0 => 'negative',
      int() || double() => 'number',
      (String a, String b) => '$a$b',
      _ => 'other',
    };

Future<void> report(List<Entry> entries, {Level level = Level.info, bool verbose = false}) async {
  final buffer = StringBuffer()..write('entries: ')..writeln(entries.length);
  for (final e in entries.where((e) => e.isCredit)) {
    if (verbose) buffer.write(e);
  }
}
