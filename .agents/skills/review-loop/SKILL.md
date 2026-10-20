---
name: review-loop
description: Limit hq-jr bot-comment rounds and require a remeasure before a fix counts. Use when a review bot comments on an hq-jr pull request.
---

# Review loop

Read a bot comment. Accept it only when you can reproduce it. Reject it with the command or the measurement that shows it is wrong.

Stop chasing hq-jr comments after 4 rounds on the same pull request. After that, trust the local checks and GitHub's own secret and severity signals.

A child that reports a fix is not done. The parent reruns the measurement. A timing claim is done only when the parent clock matches it. A leak claim is done only when the parent string no longer contains the tail.
