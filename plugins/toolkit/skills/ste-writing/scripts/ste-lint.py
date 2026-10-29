"""Heuristic anti-slop linter (ASD-STE100 mechanical subset).

Fork of ste-lint.py from github.com/woosal1337/blog @ b912d5f (MIT, (c) 2026 Ege Celebi).
See README.md for the three fixes applied. Scoring is otherwise unchanged, so
scores remain comparable with the upstream experiment numbers.
"""
import re, sys, json, glob, os

MARKETING = ["seamless","seamlessly","robust","powerful","cutting-edge","effortless","effortlessly",
    "world-class","next-generation","revolutionary","blazing","lightning-fast","elegant","delightful",
    "turnkey","best-in-class","state-of-the-art","game-changing","first-class","battle-tested",
    "enterprise-grade","supercharge","unlock","unleash","empower","empowers"]
BANNED = ["begin","begins","commence","commences","initiate","initiates","originate",
    "utilize","utilizes","utilizing","leverage","leverages","leveraging","facilitate","facilitates",
    "ensure","ensures","ensuring","prior to","subsequent to","obtain","obtains","acquire","acquires",
    "demonstrate","demonstrates","additionally","furthermore","moreover","comprehensive","comprehensively",
    "utilization","aforementioned","henceforth","therein","whilst","amongst","numerous","myriad","plethora",
    "in order to","a variety of","in the event that","due to the fact that","it is important to note"]
PHRASAL = ["spin up","spin down","reach out","dive into","dives into","diving into","kick off","kicks off",
    "roll out","rolls out","tear down","ramp up","circle back","drill down","spun up","reaching out"]
MODAL_HEDGE = ["it is important to note","it should be noted","it is worth noting","please note that",
    "as mentioned","as noted above"]
BE = r"(?:am|is|are|was|were|be|been|being)"
PP_IRREG = r"(?:done|made|sent|read|built|kept|held|set|put|run|written|shown|given|taken|found|got|gotten|seen|known|thrown|drawn)"

# FIX 2: "it's" is a contraction; "Claude's" is a possessive. Only these stems take
# a contracted 's -- every other word ending in 's is treated as possessive.
S_CONTRACTION_STEMS = {"it","that","there","here","what","who","where","when","how",
    "he","she","let","one","this","everything","something","nothing","everybody","somebody","name"}
CONTRACTION_RE = re.compile(r"\b(\w+)['’](t|re|ve|ll|d|s|m)\b", re.I)

# FIX 3: opt-in use/mention stripping -- a document *about* slop quotes the words
# it bans, and would otherwise score as slop.
QUOTED_RE = re.compile(r"[\"“][^\"“”\n]{1,300}[\"”]")


def strip_code(t):
    t = re.sub(r"```.*?```", " ", t, flags=re.S)
    t = re.sub(r"`[^`]*`", " ", t)
    return t


def strip_quoted(t):
    return QUOTED_RE.sub(" ", t)


def count_contractions(text):
    n = 0
    for m in CONTRACTION_RE.finditer(text):
        stem, suf = m.group(1).lower(), m.group(2).lower()
        if suf == "s" and stem not in S_CONTRACTION_STEMS:
            continue  # possessive, not a contraction
        n += 1
    return n


def sentences(text):
    out = []
    for line in text.split("\n"):
        s = line.strip()
        if not s: continue
        s = re.sub(r"^\s*#{1,6}\s*", "", s)
        s = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", s)
        if not s: continue
        parts = re.split(r"(?<=[.!?:])\s+(?=[A-Z0-9\"'\-])", s)
        for p in parts:
            p = p.strip()
            if p: out.append(p)
    return out


def wc(s):
    return len([w for w in re.findall(r"[A-Za-z0-9][A-Za-z0-9'\-/]*", s)])


def count_ci(text, phrases):
    n = 0; hits = []
    low = text.lower()
    for ph in phrases:
        for m in re.finditer(r"(?<![a-z])" + re.escape(ph) + r"(?![a-z])", low):
            n += 1; hits.append(ph)
    return n, hits


def lint(text, strip_quotes=False):
    raw = strip_quoted(text) if strip_quotes else text
    text = strip_code(raw)
    sents = sentences(text)
    words = sum(wc(s) for s in sents) or 1
    v = {}
    longs = [(wc(s), s) for s in sents if wc(s) > 20]
    v["long_sentence(>20w)"] = len(longs)
    v["semicolon"] = text.count(";")
    v["contraction"] = count_contractions(text)
    v["passive_voice"] = len(re.findall(rf"\b{BE}\s+(?:\w+ed|{PP_IRREG})\b", text, re.I))
    v["ing_main_verb"] = len(re.findall(rf"\b{BE}\s+\w+ing\b", text, re.I))
    v["nominalization"] = len(re.findall(r"\b(?:perform(?:s|ed)?|conduct(?:s|ed)?|provide(?:s|d)?|carry out|carries out|make use of|makes use of)\b", text, re.I)) + len(re.findall(r"\b\w{4,}(?:tion|ment|ance|ence)\s+of\b", text, re.I))
    v["phrasal_verb"], _ = count_ci(text, PHRASAL)
    v["banned_word"], bh = count_ci(text, BANNED)
    v["marketing_adjective"], mh = count_ci(text, MARKETING)
    v["modal_hedge"], _ = count_ci(text, MODAL_HEDGE)
    paras = [p for p in re.split(r"\n\s*\n", raw) if p.strip()]
    v["long_paragraph(>6s)"] = sum(1 for p in paras if len(sentences(strip_code(p))) > 6)
    em = raw.count("—") + raw.count("–")
    total = sum(v.values())
    per100 = {k: round(x*100.0/words, 2) for k, x in v.items()}
    return {
        "words": words, "sentences": len(sents),
        "violations": v, "total": total,
        "total_per100w": round(total*100.0/words, 2),
        "em_dash(slop-marker)": em,
        "longest_sentence_words": (max(longs)[0] if longs else max((wc(s) for s in sents), default=0)),
        "sample_marketing": list(dict.fromkeys(mh))[:6],
        "sample_banned": list(dict.fromkeys(bh))[:6],
    }


USAGE = """usage: ste-lint.py [--strip-quotes] [FILE ...]

Score is violations per 100 words; lower is cleaner. With no FILE, reads stdin
and prints JSON. em_dash is reported but excluded from the total, matching
upstream.

  --strip-quotes   ignore text inside double quotes, so a document *about* slop
                   is not scored for the words it quotes in order to ban them
"""

if __name__ == "__main__":
    args = sys.argv[1:]
    if "-h" in args or "--help" in args:
        print(USAGE); sys.exit(0)
    strip_q = "--strip-quotes" in args
    unknown = [a for a in args if a.startswith("--") and a != "--strip-quotes"]
    if unknown:
        print(f"unknown option: {unknown[0]}\n\n{USAGE}", file=sys.stderr); sys.exit(2)
    files = [a for a in args if not a.startswith("--")]

    # FIX 1: force UTF-8 everywhere. Without this Windows uses cp1252 and every
    # em dash silently decodes to mojibake, so em_dash reports ~0 on real files.
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    if not files:
        print(json.dumps(lint(sys.stdin.read(), strip_q), indent=2)); sys.exit(0)
    exp = []
    for f in files: exp += sorted(glob.glob(f)) if any(c in f for c in "*?[") else [f]
    for f in exp:
        with open(f, encoding="utf-8", errors="replace") as fh: r = lint(fh.read(), strip_q)
        print(f"{os.path.basename(f):32} words={r['words']:4d} total={r['total']:3d} per100w={r['total_per100w']:6.2f} em_dash={r['em_dash(slop-marker)']:2d}")
