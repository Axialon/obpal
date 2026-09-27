# Lane prompt template

Fill in the angle brackets and drop the lines that don't apply. The obpal-lane agent already has the rules, the ports policy, e2e, commits, merging master and the hand-back format, so don't repeat them.

```
Lane <letter>: <title>. Stand-in port <5177–5188>, worker port <5190–5199>. Base: master <sha>.

The owner's words (verbatim):
"<quote>"

Task:
- <outcome, stated as what the owner will see or be able to do>
- <outcome>

Owns: <files or areas>. Don't touch: <what other lanes hold, and why>.
Contracts: <an interface agreed with another lane, or "none">.
Interim: <e.g. "after the survey, send main a proposal of at most 150 words, then build without waiting">, or none.
Done when: <the suites and numbers that must pass, screenshots, measurements>.
```

Good prompts name outcomes and constraints, not steps. They quote the owner, and they say what "done" looks like so the hand-back can prove it.
