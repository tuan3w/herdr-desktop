//! A tiny ledger: entries in, balance out.

use std::collections::HashMap;
use std::fmt;

/// The most entries one account keeps.
pub const MAX_ENTRIES: usize = 1_024;
static GREETING: &str = "hello\tworld\n";

#[derive(Debug, Clone, PartialEq)]
pub enum Kind<'a> {
    Credit(u64),
    Debit { amount: u64, memo: &'a str },
    Void,
}

/// One account.
#[derive(Default)]
pub struct Account<T: Copy + Into<u64>> {
    pub name: String,
    entries: Vec<T>,
}

impl<T: Copy + Into<u64>> Account<T> {
    /// Adds `entry`, or says why it did not fit.
    pub fn push(&mut self, entry: T) -> Result<(), LedgerError> {
        // TODO: reject duplicates
        if self.entries.len() >= MAX_ENTRIES {
            return Err(LedgerError::Full { limit: MAX_ENTRIES });
        }
        self.entries.push(entry);
        Ok(())
    }

    pub fn balance(&self) -> u64 {
        self.entries.iter().map(|&e| e.into()).sum::<u64>()
    }
}

#[derive(Debug)]
pub enum LedgerError {
    Full { limit: usize },
}

impl fmt::Display for LedgerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Full { limit } => write!(f, "full at {limit} entries"),
        }
    }
}

macro_rules! twice {
    ($e:expr) => { $e * 2 };
}

pub trait Store {
    const LIMIT: u32;
    async fn load(&self, key: &str) -> Option<Vec<u8>>;
}

fn main() {
    let mut accounts: HashMap<&str, Account<u32>> = HashMap::new();
    let acme = accounts.entry("acme").or_default();
    for n in 0..=3u32 {
        if let Err(e) = acme.push(n * 0x10) {
            eprintln!("{e}");
            break;
        }
    }
    let total = accounts.values().fold(0u64, |sum, a| sum + a.balance());
    'scan: loop {
        let ptr = &total as *const u64;
        break 'scan unsafe { *ptr };
    }
    println!("{} {}", twice!(total), r#"raw "string""#);
}
