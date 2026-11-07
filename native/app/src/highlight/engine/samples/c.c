#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_ENTRIES 1024
#define SQUARE(x) ((x) * (x))

/* One posting on an account. */
typedef struct entry {
    char name[32];
    long cents;
    struct entry *next;
} entry_t;

enum level { LEVEL_DEBUG, LEVEL_INFO = 2, LEVEL_WARN };

static const char *const GREETING = "hello\tworld\n";

// TODO: free the list on error
static entry_t *push(entry_t *head, const char *name, long cents) {
    entry_t *e = malloc(sizeof *e);
    if (e == NULL) {
        fprintf(stderr, "out of memory\n");
        return head;
    }
    strncpy(e->name, name, sizeof(e->name) - 1);
    e->name[sizeof(e->name) - 1] = '\0';
    e->cents = cents;
    e->next = head;
    return e;
}

long balance(const entry_t *head, const char *name) {
    long sum = 0;
    for (const entry_t *e = head; e; e = e->next) {
        if (strcmp(e->name, name) == 0) sum += e->cents;
    }
    return sum;
}

int main(int argc, char **argv) {
    entry_t *list = NULL;
    list = push(list, "acme", 1500);
    list = push(list, "acme", -SQUARE(10));
    printf("%s balance=%ld argc=%d 0x%X\n", GREETING, balance(list, "acme"), argc, 255u);
    return argv[0] ? 0 : 1;
}
