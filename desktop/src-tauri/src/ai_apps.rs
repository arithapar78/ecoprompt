//! Process-name -> display group. Matching is on the NORMALIZED base name
//! (lowercase, no `.exe`, macOS helper suffix removed), by exact name, never by
//! substring: `cursorUIViewService` is a macOS system process, not Cursor.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Ai,
    Browser,
    Ide,
    Other,
}

struct Rule {
    group: &'static str,
    kind: Kind,
    names: &'static [&'static str],
}

/// First match wins. Browsers each keep their own group; the UI sums them as
/// "Browsers". Safari's WebKit content processes (`com.apple.WebKit.*`) are
/// shared by every WebKit app and can't be attributed, so they land in Other.
const RULES: &[Rule] = &[
    Rule { group: "ChatGPT", kind: Kind::Ai, names: &["chatgpt"] },
    Rule { group: "Claude", kind: Kind::Ai, names: &["claude"] },
    Rule { group: "Perplexity", kind: Kind::Ai, names: &["perplexity"] },
    Rule { group: "Copilot", kind: Kind::Ai, names: &["copilot", "github copilot", "microsoft copilot"] },
    Rule { group: "Cursor", kind: Kind::Ai, names: &["cursor"] },
    Rule { group: "VS Code", kind: Kind::Ide, names: &["code", "visual studio code", "code - insiders"] },
    Rule { group: "Chrome", kind: Kind::Browser, names: &["google chrome", "chrome"] },
    Rule { group: "Edge", kind: Kind::Browser, names: &["microsoft edge", "msedge"] },
    Rule { group: "Safari", kind: Kind::Browser, names: &["safari"] },
    Rule { group: "Firefox", kind: Kind::Browser, names: &["firefox", "plugin-container"] },
    Rule { group: "Arc", kind: Kind::Browser, names: &["arc"] },
    Rule { group: "Brave", kind: Kind::Browser, names: &["brave browser", "brave"] },
];

pub const OTHER: &str = "Other";
/// Unknown processes keep their own name only if they're in this many top groups.
pub const KEEP_TOP: usize = 5;

/// "Google Chrome Helper (Renderer)" -> "Google Chrome"; "chrome.exe" -> "chrome".
pub fn base_name(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    if s.to_lowercase().ends_with(".exe") {
        s.truncate(s.len() - 4);
    }
    if let Some(i) = s.to_lowercase().find(" helper") {
        s.truncate(i);
    }
    s.trim().to_string()
}

pub fn classify(raw: &str) -> Option<(&'static str, Kind)> {
    let lower = base_name(raw).to_lowercase();
    if lower.starts_with("safari") {
        return Some(("Safari", Kind::Browser));
    }
    RULES
        .iter()
        .find(|r| r.names.contains(&lower.as_str()))
        .map(|r| (r.group, r.kind))
}

pub fn kind_of_group(group: &str) -> Kind {
    RULES.iter().find(|r| r.group == group).map(|r| r.kind).unwrap_or(Kind::Other)
}

#[derive(Clone, Debug, PartialEq)]
pub struct GroupCpu {
    pub group: String,
    pub kind: Kind,
    pub cpu: f64,
}

/// Sum CPU per group. Known apps keep their group. Unknown processes keep their
/// own base name only if that name is in the overall top `KEEP_TOP`; otherwise
/// they're folded into "Other". Sorted by CPU, highest first.
pub fn aggregate<'a>(procs: impl IntoIterator<Item = (&'a str, f64)>) -> Vec<GroupCpu> {
    let mut map: HashMap<String, (Kind, f64)> = HashMap::new();
    for (name, cpu) in procs {
        if !cpu.is_finite() || cpu < 0.0 {
            continue;
        }
        let (group, kind) = match classify(name) {
            Some((g, k)) => (g.to_string(), k),
            None => {
                let b = base_name(name);
                (if b.is_empty() { OTHER.to_string() } else { b }, Kind::Other)
            }
        };
        map.entry(group).or_insert((kind, 0.0)).1 += cpu;
    }
    let mut all: Vec<GroupCpu> = map
        .into_iter()
        .map(|(group, (kind, cpu))| GroupCpu { group, kind, cpu })
        .collect();
    all.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap().then_with(|| a.group.cmp(&b.group)));

    let mut out: Vec<GroupCpu> = Vec::new();
    let mut other = 0.0;
    for (rank, g) in all.into_iter().enumerate() {
        let known = g.kind != Kind::Other;
        if known || rank < KEEP_TOP {
            out.push(g);
        } else {
            other += g.cpu;
        }
    }
    if other > 0.0 {
        // Merge into an existing "Other" if an unknown process was literally named that.
        match out.iter_mut().find(|g| g.group == OTHER) {
            Some(g) => g.cpu += other,
            None => out.push(GroupCpu { group: OTHER.into(), kind: Kind::Other, cpu: other }),
        }
    }
    out.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap().then_with(|| a.group.cmp(&b.group)));
    out
}

/// CPU the OS reports in total but no process claimed (processes first seen
/// this sample read 0%, short-lived ones vanish). Goes to "Other" so watts are
/// conserved instead of inflating everyone else's share.
pub fn add_unattributed(groups: &mut Vec<GroupCpu>, total_cpu: f64) {
    let seen: f64 = groups.iter().map(|g| g.cpu).sum();
    let missing = total_cpu - seen;
    if !missing.is_finite() || missing <= 0.0 {
        return;
    }
    match groups.iter_mut().find(|g| g.group == OTHER) {
        Some(g) => g.cpu += missing,
        None => groups.push(GroupCpu { group: OTHER.into(), kind: Kind::Other, cpu: missing }),
    }
    groups.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap().then_with(|| a.group.cmp(&b.group)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unattributed_cpu_goes_to_other_and_total_is_conserved() {
        let mut g = aggregate([("Google Chrome", 40.0), ("Claude", 10.0)]);
        add_unattributed(&mut g, 150.0);
        assert_eq!(g.iter().map(|x| x.cpu).sum::<f64>(), 150.0);
        assert_eq!(g[0].group, "Other");
        assert_eq!(g[0].cpu, 100.0);
        // Nothing missing -> unchanged.
        let before = g.clone();
        add_unattributed(&mut g, 150.0);
        assert_eq!(g, before);
        add_unattributed(&mut g, 10.0);
        assert_eq!(g, before);
    }

    #[test]
    fn mac_helper_processes_roll_up_to_parent() {
        for n in ["Google Chrome", "Google Chrome Helper", "Google Chrome Helper (Renderer)", "Google Chrome Helper (GPU)", "chrome.exe", "CHROME"] {
            assert_eq!(classify(n), Some(("Chrome", Kind::Browser)), "{n}");
        }
        assert_eq!(classify("Code Helper (Plugin)"), Some(("VS Code", Kind::Ide)));
        assert_eq!(classify("Claude Helper (Renderer)"), Some(("Claude", Kind::Ai)));
        assert_eq!(classify("msedge.exe"), Some(("Edge", Kind::Browser)));
        assert_eq!(classify("Safari Web Content"), Some(("Safari", Kind::Browser)));
    }

    #[test]
    fn matching_is_exact_not_substring() {
        assert_eq!(classify("cursorUIViewService"), None);
        assert_eq!(classify("Archive Utility"), None);
        assert_eq!(classify("codesign"), None);
        assert_eq!(classify("com.apple.WebKit.WebContent"), None);
    }

    #[test]
    fn ai_kinds() {
        assert_eq!(kind_of_group("ChatGPT"), Kind::Ai);
        assert_eq!(kind_of_group("Chrome"), Kind::Browser);
        assert_eq!(kind_of_group("VS Code"), Kind::Ide);
        assert_eq!(kind_of_group("whatever"), Kind::Other);
    }

    #[test]
    fn aggregate_sums_helpers_and_folds_small_unknowns_into_other() {
        let procs: Vec<(&str, f64)> = vec![
            ("Google Chrome", 10.0),
            ("Google Chrome Helper (Renderer)", 30.0),
            ("Google Chrome Helper (GPU)", 10.0),
            ("a", 9.0), ("b", 8.0), ("c", 7.0), ("d", 6.0), ("e", 5.0),
            ("tiny1", 1.0), ("tiny2", 2.0),
        ];
        let out = aggregate(procs.iter().map(|(n, c)| (*n, *c)));
        let chrome = out.iter().find(|g| g.group == "Chrome").unwrap();
        assert_eq!(chrome.cpu, 50.0);
        // Chrome + a,b,c,d are the top 5; e, tiny1, tiny2 fold into Other.
        let other = out.iter().find(|g| g.group == OTHER).unwrap();
        assert_eq!(other.cpu, 5.0 + 1.0 + 2.0);
        assert!(out.iter().any(|g| g.group == "a"));
        assert!(!out.iter().any(|g| g.group == "tiny1"));
        // Total CPU is conserved.
        assert_eq!(out.iter().map(|g| g.cpu).sum::<f64>(), 88.0);
        assert_eq!(out[0].group, "Chrome");
    }

    #[test]
    fn aggregate_ignores_bad_values() {
        let out = aggregate([("x", f64::NAN), ("y", -3.0), ("z", 2.0)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].group, "z");
    }
}
