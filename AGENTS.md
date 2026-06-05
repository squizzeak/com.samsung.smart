# AGENTS

## Source Of Truth
- `app.json` is generated. Edit `.homeycompose/app.json` and the compose fragments under `.homeycompose/` plus `drivers/*/*.compose.json`; do not hand-edit generated `app.json`.
- Homey Compose regenerates the real `app.json` during `homey app run` and publish/install flows; if manifest changes seem to disappear, you likely edited the generated file instead of the compose source.
- The root app and the CLI are separate TypeScript packages with separate `package.json` and `tsconfig.json`. Root `tsconfig.json` explicitly excludes `cmd/**/*`.

## Package Boundaries
- Root package is the Homey SDK v3 app. Main entrypoint is `app.ts`.
- `app.ts` only wires Flow cards. Device behavior lives in `lib/BaseDevice.ts` and protocol-specific `drivers/*/device.ts`.
- Pairing logic lives in `drivers/*/driver.ts`.
- The app currently supports only `drivers/Samsung/*`: TVs on port `8001`, plus SmartThings support.
- `cmd/` is a separate CLI package (`sfp`) that reuses the root library and client code; its persistent settings are stored outside the repo in `~/.samsung-cli/settings.json` on macOS/Linux.

## Commands
- Install root deps with `npm install`.
- Run the Homey app locally with live logs using `homey app run`. Per Homey CLI docs, stopping it with `Ctrl+C` uninstalls the app.
- Install the app on a Homey without keeping a live session open using `homey app install`.
- Validate the Homey manifest directly with `homey app validate`.
- Run the root test suite with `npm test`.
- `npm test` is not just Mocha: root `posttest` runs `homey app validate`, so the Homey CLI must be available for the full script to pass.
- For a focused root test without `posttest`, use the same Mocha setup as `package.json`: `env TS_NODE_COMPILER_OPTIONS='{"module": "commonjs" }' mocha -r ts-node/register 'test/<file>.ts'`.
- There is no root lint/typecheck script. Root verification is test-driven unless you intentionally run tools manually.
- CLI work happens from `cmd/`. Compile only: `npm --prefix cmd run compile`.
- `cmd/package.json` has a `build` script, but it shells out to `yarn clean && yarn compile`; do not assume `npm --prefix cmd run build` works unless `yarn` is installed.

## Testing Notes
- Root tests are small unit-style Mocha tests under `test/`; they instantiate client objects directly with mocks from `test/HomeyDevice.ts`.
- The most targeted tests for command parsing live in `test/test_commands*.ts`, `test/test_send_keys.ts`, and the client-construction helpers in `test/test_create_*.ts`.

## Repo-Specific Gotchas
- `app.ts` disables TLS verification globally with `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'`; avoid “fixing” TLS behavior accidentally when touching startup code.
- `drivers/Samsung/device.ts` is the only device that wires `SmartThingsClientImpl`.
- `drivers/Samsung/driver.ts` explicitly rejects older encrypted/legacy model families by checking `modelClass(info.device.modelName) === undefined`; preserve that filter unless you intend to reintroduce older protocol support.
