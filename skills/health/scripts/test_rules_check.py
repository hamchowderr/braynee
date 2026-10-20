"""Unit tests for rules_check.py. Run: python3 -m unittest discover -s skills/health/scripts -p "test_*.py"."""

import tempfile
import unittest
from pathlib import Path

import rules_check as rc


def write(p: Path, text: str) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(text.encode("utf-8"))
    return p


class Tmp(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.root = Path(self._t.name)

    def tearDown(self):
        self._t.cleanup()


class PathGlobs(unittest.TestCase):
    def test_block_inline_and_none(self):
        self.assertEqual(rc.path_globs('---\npaths:\n  - "**/*.ts"\n  - src/**\n---\n# x'), ["**/*.ts", "src/**"])
        self.assertEqual(rc.path_globs("---\npaths: [\"a/**\", 'b/**']\n---\n"), ["a/**", "b/**"])
        self.assertEqual(rc.path_globs("---\npaths: docs/**\n---\n"), ["docs/**"])
        self.assertEqual(rc.path_globs("# no frontmatter"), [])
        self.assertEqual(rc.path_globs("---\ndescription: x\n---\n"), [])

    def test_crlf_frontmatter(self):
        self.assertEqual(rc.path_globs('---\r\npaths:\r\n  - "**/*.py"\r\n---\r\n'), ["**/*.py"])


class UserLayer(Tmp):
    def test_sizes_unscoped_and_absolute_globs(self):
        c = self.root / ".claude"
        write(c / "CLAUDE.md", "x" * 100)
        write(c / "rules" / "always.md", "# always\n")
        write(c / "rules" / "scoped.md", '---\npaths:\n  - "**/*.test.*"\n---\n# t\n')
        write(c / "rules" / "bad.md", '---\npaths:\n  - "C:/Users/me/code/**"\n  - "/home/me/**"\n---\n')
        out = rc.check_user_layer(c)
        self.assertEqual(out["claude_md_bytes"], 100)
        self.assertEqual(out["unscoped"], ["always.md"])
        self.assertEqual(out["always_on_bytes"], 100 + len("# always\n"))
        self.assertEqual(out["absolute_globs"], ["bad.md: C:/Users/me/code/**", "bad.md: /home/me/**"])


class DeadReferences(Tmp):
    def test_rule_skill_and_wikilink_refs(self):
        c = self.root / ".claude"
        write(c / "rules" / "shipping.md", "# s\n")
        vault = self.root / "vault"
        write(vault / "Notes" / "Service Model.md", "x")
        write(vault / "img.png", "x")
        user = [write(c / "CLAUDE.md",
                      "See ~/.claude/rules/shipping.md and ~/.claude/rules/ship-pipeline.md.\n"
                      "Links: [[Service Model]], [[Notes/Service Model|alias]], [[Gone Note]], [[img.png]], [[#Heading]].\n"
                      "Run /braynee:health and /braynee:tasks.\n")]
        plugin = [write(self.root / "plugin" / "agents" / "a.md", "Read ~/.claude/rules/old.md. [[Example Link]]")]
        out = rc.check_dead_references(user, plugin, c, vault, {"health"})
        self.assertEqual(out["rule_refs"], ["CLAUDE.md -> ~/.claude/rules/ship-pipeline.md", "a.md -> ~/.claude/rules/old.md"])
        self.assertEqual(out["skills"], ["CLAUDE.md -> /braynee:tasks"])
        # Plugin text is not checked for wikilinks; heading-only links are not note links.
        self.assertEqual(out["wikilinks"], ["CLAUDE.md -> [[Gone Note]]"])

    def test_no_vault_skips_wikilinks(self):
        c = self.root / ".claude"
        user = [write(c / "CLAUDE.md", "[[Anything]]")]
        self.assertEqual(rc.check_dead_references(user, [], c, None, set())["wikilinks"], [])


class Projects(Tmp):
    def repo(self, rel: str, claude=None, agents=None) -> Path:
        r = self.root / "code" / rel
        (r / ".git").mkdir(parents=True)
        if claude is not None:
            write(r / "CLAUDE.md", claude)
        if agents is not None:
            write(r / "AGENTS.md", agents)
        return r

    def test_find_repos_two_levels(self):
        self.repo("a")
        self.repo("group/b")
        self.repo("group/deep/c")
        names = [r.name for r in rc.find_repos(self.root / "code")]
        self.assertEqual(names, ["a", "b"])

    def test_agents_skipped_identical_copies_and_budget(self):
        self.repo("imports", claude="@AGENTS.md\n", agents="# a\n")
        self.repo("imports-plus", claude="# Claude only\n\n@AGENTS.md\n", agents="# a\n")
        self.repo("skips", claude="# own text\n", agents="# a\n")
        self.repo("same", claude="# same\n", agents="# same\n")
        self.repo("agents-only", agents="# a\n")
        self.repo("copy1", claude="# shared\n")
        self.repo("copy2", claude="# shared\r\n")
        self.repo("big", claude="x" * (rc.FILE_BUDGET + 1))
        out = rc.check_projects(rc.find_repos(self.root / "code"))
        self.assertEqual(out["repos"], 8)
        self.assertEqual(out["agents_skipped"], ["skips"])
        self.assertEqual(out["identical_pair"], ["same"])
        self.assertIn(["copy1", "copy2"], out["copies"])
        self.assertFalse(any("imports" in g for grp in out["copies"] for g in grp))
        self.assertEqual(out["over_budget"], ["big/CLAUDE.md 5 KB"])


class Memory(Tmp):
    def test_index_feedback_and_rule_naming(self):
        m = self.root / "mem"
        write(m / "MEMORY.md", "# Index\n- short entry\n- " + "y" * 200 + "\n")
        write(m / "feedback_x.md", "---\nname: x\nmetadata:\n  type: feedback\n---\nDo X.")
        write(m / "untyped.md", "---\nname: u\n---\nThe `testing` rule is wrong about Y.")
        write(m / "project_y.md", "---\nname: y\nmetadata:\n  type: project\n---\nSee the `testing` rule.")
        write(m / "ARCHIVED.md", "---\ntype: feedback\n---\n")
        out = rc.check_memory(m, {"testing.md"})
        self.assertEqual(out["index_lines"], 3)
        self.assertEqual(len(out["long_entries"]), 1)
        self.assertEqual(out["feedback"], ["feedback_x"])
        self.assertEqual(out["names_rule"], ["untyped"])

    def test_missing_dir(self):
        self.assertEqual(rc.check_memory(None, set())["index_lines"], 0)


class Report(Tmp):
    def test_report_runs_and_flags(self):
        c = self.root / ".claude"
        write(c / "CLAUDE.md", "x" * (rc.FILE_BUDGET + 10) + "\n[[Missing]]\n")
        lines = []
        rc.report(lambda s: lines.append("ok " + s), lambda s: lines.append("warn " + s),
                  claude_dir=c, vault=self.root / "vault", projects_dir=self.root / "code",
                  memory_dir=None, plugin_root=None)
        text = "\n".join(lines)
        self.assertIn("warn User CLAUDE.md", text)
        self.assertIn("warn 1 wikilinks", text)
        self.assertIn("No git repos under", text)


if __name__ == "__main__":
    unittest.main()
