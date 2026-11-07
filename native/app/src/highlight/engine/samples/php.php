<?php

declare(strict_types=1);

namespace Dev\Example\Ledger;

use InvalidArgumentException;

const MAX_ENTRIES = 1_024;

/** One posting on an account. */
final class Entry
{
    public function __construct(
        public readonly string $name,
        public readonly int $cents,
        private ?string $memo = null,
    ) {}

    public function memo(): string
    {
        return $this->memo ?? '(none)';
    }
}

interface Store
{
    public function put(Entry $entry): void;
}

#[\AllowDynamicProperties]
class Ledger implements Store, \Countable
{
    /** @var array<string, Entry[]> */
    private array $items = [];

    // TODO: reject duplicates
    public function put(Entry $entry): void
    {
        if (count($this->items[$entry->name] ?? []) >= MAX_ENTRIES) {
            throw new InvalidArgumentException("full: {$entry->name}");
        }
        $this->items[$entry->name][] = $entry;
    }

    public function balance(string $name): int
    {
        return array_sum(array_map(fn (Entry $e) => $e->cents, $this->items[$name] ?? []));
    }
}

$book = new Ledger();
$book->put(new Entry('acme', 1_500, memo: 'invoice'));
echo sprintf("balance: %d\n", $book->balance('acme'));

enum Kind: string
{
    case Debit = 'debit';
    case Credit = 'credit';

    public static function from_cents(int $cents): self
    {
        return $cents < 0 ? self::Debit : static::Credit;
    }
}

function describe(?Entry $entry, string ...$tags): string
{
    $kind = match (true) {
        $entry === null => 'none',
        $entry->cents >= 0 => Kind::Credit->value,
        default => 'debit',
    };
    return <<<TXT
    {$entry?->name} is $kind [{$tags[0]}]\t{$entry->memo()}
    TXT;
}
