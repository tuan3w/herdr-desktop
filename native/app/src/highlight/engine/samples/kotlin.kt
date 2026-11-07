// The benches repeat this file: no package/import (errors when repeated) and no annotation with
// arguments on a statement or class (the grammar parses those 2-3x slower and never reuses them).
const val MAX_ENTRIES = 1_024

/** One posting on an account. */
data class Entry(val name: String, val cents: Long, val memo: String? = null)

sealed interface Result<out T> {
    data class Ok<T>(val value: T) : Result<T>
    data class Failed(val reason: String) : Result<Nothing>
}

class Ledger(private val limit: Int = MAX_ENTRIES) {
    private val items = mutableMapOf<String, MutableList<Entry>>()
    private val clock: java.time.Clock = java.time.Clock.systemUTC()

    // TODO: make this thread safe
    fun put(entry: Entry): Result<Unit> {
        val list = items.getOrPut(entry.name) { mutableListOf() }
        if (list.size >= limit) return Result.Failed("full: ${entry.name}")
        list += entry
        return Result.Ok(Unit)
    }

    @Suppress("UNCHECKED_CAST")
    fun balance(name: String): Long = items[name].orEmpty().sumOf { it.cents }

    fun watch(name: String): Flow<Long> = flow {
        while (true) {
            emit(balance(name))
            kotlinx.coroutines.delay(1_000L)
        }
    }
}

fun main() {
    val ledger = Ledger()
    when (val r = ledger.put(Entry("acme", 1_500, memo = "invoice #12"))) {
        is Result.Ok -> println("balance=${ledger.balance("acme")}\t(ok)")
        is Result.Failed -> println("failed: ${r.reason}")
    }
}

enum class Level(val weight: Int) { LOW(1), HIGH(2) }

suspend fun Ledger.total(name: String): Long = coroutineScope {
    val parts = listOf(1, 2).map { async { balance(name) * it } }
    parts.awaitAll().sum()
}
