//! Reading what a keeper `attach` prints: JSON-RPC lines, optionally `Z<base64>` batches of one zlib stream.
//!
//! `attach --z` (used over ssh, where a long replay is the cost) writes a batch of at least 512 bytes as one
//! `Z` line holding base64 of zlib data; every batch of the stream ends with a sync flush, so each can be
//! inflated as it arrives. Smaller batches travel as plain lines.

use std::io::{self, BufRead};

use flate2::{Decompress, FlushDecompress, Status};

/// The longest line accepted: what the keeper itself allows from an agent.
pub const MAX_LINE: usize = 64 * 1024 * 1024;

/// Splits a byte stream into lines with a cap, never holding more than the cap in memory.
pub(crate) struct Lines<R> {
    reader: R,
    max: usize,
}

impl<R: BufRead> Lines<R> {
    pub(crate) fn new(reader: R, max: usize) -> Self {
        Self { reader, max }
    }

    /// The next line without its newline (and without a carriage return); `Ok(None)` at the end.
    pub(crate) fn next_line(&mut self) -> io::Result<Option<Vec<u8>>> {
        let mut line = Vec::new();
        loop {
            let (done, used) = {
                let chunk = self.reader.fill_buf()?;
                if chunk.is_empty() {
                    return Ok((!line.is_empty()).then_some(line));
                }
                match chunk.iter().position(|b| *b == b'\n') {
                    Some(at) => {
                        line.extend_from_slice(&chunk[..at]);
                        (true, at + 1)
                    }
                    None => {
                        line.extend_from_slice(chunk);
                        (false, chunk.len())
                    }
                }
            };
            self.reader.consume(used);
            if line.len() > self.max {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "a line from the keeper is longer than allowed",
                ));
            }
            if done {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(Some(line));
            }
        }
    }
}

/// Reads the lines of an attach stream, inflating `Z` batches when the stream is zipped.
pub(crate) struct AttachLines<R> {
    lines: Lines<R>,
    zipped: Option<Decompress>,
    /// Inflated bytes of the current batch that are not a whole line yet.
    held: Vec<u8>,
    ready: std::collections::VecDeque<String>,
}

impl<R: BufRead> AttachLines<R> {
    /// A reader of `reader`; `zipped` when the keeper was started with `attach --z`.
    pub(crate) fn new(reader: R, zipped: bool) -> Self {
        Self {
            lines: Lines::new(reader, MAX_LINE),
            zipped: zipped.then(|| Decompress::new(true)),
            held: Vec::new(),
            ready: std::collections::VecDeque::new(),
        }
    }

    /// The next JSON line; `Ok(None)` when the keeper hung up.
    pub(crate) fn next_line(&mut self) -> io::Result<Option<String>> {
        loop {
            if let Some(line) = self.ready.pop_front() {
                return Ok(Some(line));
            }
            let Some(raw) = self.lines.next_line()? else {
                return Ok(None);
            };
            match (&mut self.zipped, raw.first()) {
                (Some(z), Some(b'Z')) => {
                    let packed = decode_base64(&raw[1..]).ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidData, "a zipped batch is not base64")
                    })?;
                    let inflated = inflate(z, &packed)?;
                    self.held.extend_from_slice(&inflated);
                    // A batch is cut at line ends, so what is held is whole lines; a stray tail waits for
                    // the next batch.
                    while let Some(at) = self.held.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = self.held.drain(..=at).collect();
                        let text = String::from_utf8_lossy(&line[..at]).into_owned();
                        if !text.trim().is_empty() {
                            self.ready.push_back(text);
                        }
                    }
                }
                _ => {
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if !text.trim().is_empty() {
                        self.ready.push_back(text);
                    }
                }
            }
        }
    }
}

/// Inflates one sync-flushed batch of a zlib stream.
fn inflate(z: &mut Decompress, packed: &[u8]) -> io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(packed.len().saturating_mul(8));
    let mut input = packed;
    loop {
        let before = z.total_in();
        let status = z
            .decompress_vec(input, &mut out, FlushDecompress::Sync)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let used = usize::try_from(z.total_in() - before).unwrap_or(input.len());
        input = &input[used.min(input.len())..];
        if out.len() > MAX_LINE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "a zipped batch from the keeper inflates past the allowed size",
            ));
        }
        // Output space ran out when the buffer is exactly full: make room and go on.
        if input.is_empty() && out.len() < out.capacity() {
            return Ok(out);
        }
        if status == Status::StreamEnd {
            return Ok(out);
        }
        out.reserve(out.capacity().max(4096));
    }
}

/// Standard base64, whitespace ignored; `None` for anything else.
pub(crate) fn decode_base64(text: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in text {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b' ' | b'\t' | b'\r' | b'\n' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    use flate2::{Compress, Compression, FlushCompress};

    fn base64(bytes: &[u8]) -> String {
        crate::ssh::base64(bytes)
    }

    #[test]
    fn a_zipped_stream_comes_back_line_by_line_across_batches() {
        let mut z = Compress::new(Compression::new(6), true);
        let mut pack = |text: &str| {
            let mut out = Vec::with_capacity(text.len() + 64);
            z.compress_vec(text.as_bytes(), &mut out, FlushCompress::Sync)
                .expect("compress");
            format!("Z{}\n", base64(&out))
        };
        let mut wire = Vec::new();
        wire.extend_from_slice(pack("{\"a\":1}\n{\"b\":2}\n").as_bytes());
        // A plain line between batches is passed through as it is.
        wire.extend_from_slice(b"{\"plain\":true}\n");
        wire.extend_from_slice(pack("{\"c\":3}\n").as_bytes());
        let mut lines = AttachLines::new(Cursor::new(wire), true);
        let mut got = Vec::new();
        while let Some(line) = lines.next_line().expect("read") {
            got.push(line);
        }
        assert_eq!(
            got,
            ["{\"a\":1}", "{\"b\":2}", "{\"plain\":true}", "{\"c\":3}"]
        );
    }

    #[test]
    fn a_line_over_the_cap_ends_the_stream_instead_of_filling_memory() {
        let mut lines = Lines::new(Cursor::new(vec![b'x'; 100]), 10);
        assert!(lines.next_line().is_err());
    }

    #[test]
    fn base64_round_trips() {
        for sample in [&b""[..], b"a", b"ab", b"abc", b"abcd", &[0, 255, 7, 8, 9]] {
            assert_eq!(
                decode_base64(base64(sample).as_bytes()).as_deref(),
                Some(sample)
            );
        }
        assert_eq!(decode_base64(b"not base64!"), None);
    }
}
