# Contributing

Thanks for your interest in improving the Cosmo examples.

## How this repository works

Development of the Cosmo SDKs happens in Socratic AI's internal monorepo.
This repository is a release mirror: each release is exported here as a
single commit (the `Monorepo-commit` trailer records the internal source
revision), and tags are immutable. There is no development branch here.

## Bugs and feature requests

Please open an issue on this repository. Include the SDK version and a
minimal reproduction where possible. For anything security-related, use
private vulnerability reporting (the Security tab) instead of an issue —
see the organization security policy.

## Pull requests

Pull requests are welcome. Because this repo is a mirror, accepted changes
are imported into the internal repository with `Co-authored-by` credit and
appear in the next tagged release, rather than being merged here directly.
We'll keep you posted on the issue or PR about when your change ships.

## Adding or changing an example

Examples are the one place where contributions are most direct: open a PR
here and we'll import it. Keep each example self-contained (own README and
`.env.example`), depend on the published SDK packages (never local paths),
and don't commit credentials.

## Code of conduct

This project follows the organization-wide
[Code of Conduct](https://github.com/socratic-ai/.github/blob/main/CODE_OF_CONDUCT.md).
