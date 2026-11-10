# Bluetooth Classic (SPP) Receipt Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The POS prints to Bluetooth Classic (serial port, SPP) receipt printers such as the Rongta RPP02N, alongside the existing BLE path, without re-pairing.

**Architecture:**
- A small in-house Capacitor plugin (`ClassicPrinter`, Java) opens an RFCOMM socket to a bonded printer. It runs on its own background thread.
- In TypeScript, an `AutoBluetoothTransport` looks up the stored printer address in the OS bonded list at connect time. It sends serial-port printers to the new `ClassicSppTransport` and everything else to the existing `CapacitorBleTransport`.
- Print errors are mapped to Indonesian messages that start with "Gagal".
- Print jobs are serialized, so two prints never share one socket.

**Tech Stack:** Capacitor 8.5.3 (Android, Java), TypeScript, vitest. No new npm dependency.

**Spec:** this document's Background section. It holds the owner's request ("Yes, plan it", 2026-11-10) and the diagnosis.

## Background (the diagnosis this plan acts on)

- **The printer:** the owner's test printer pairs as "RPPO2N" (Rongta RPP02N). `adb shell dumpsys bluetooth_manager` shows it bonded as type DUAL with only the SPP profile.
- **What the POS does today:** it prints over BLE only ([ble.ts](../../packages/printer/src/ble.ts)).
- **What happens on the device (all three of the owner's attempts):**
  - The LE link opens and `GATTC_Discover` is sent. The printer never answers.
  - The bluetooth-le plugin times out after 10 s and the POS shows its raw "Connection timeout.".
  - With a 40 s connect, Android's own ATT timer fires at 30 s (`gatt_rsp_timeout`) and drops the link.
- **Existing plugins:** every Bluetooth Classic Capacitor plugin on npm targets Capacitor 6 or 7 (`@kduma-autoid/capacitor-bluetooth-printer`, `@e-is/capacitor-bluetooth-serial`, `capacitor-thermal-printer`), and the app is on Capacitor 8.5.3. So the plugin is in-house, following `OutboxJournalPlugin.java`.

## Global Constraints

- No new npm dependency, so no `package.json` or `pnpm-lock.yaml` change.
- Native code is Java in package `com.mandalika.pos`, the same as `OutboxJournalPlugin.java`.
- The plugin is registered in `MainActivity.onCreate` before `super.onCreate`.
- SPP service UUID: `00001101-0000-1000-8000-00805F9B34FB`.
- Connect timeout: `10000` ms, the same as the BLE plugin default.
- Every print-error message shown to the user is Indonesian and starts with `Gagal`. Settings colours `printerMsg` red only when it contains `Gagal` or `Tidak` (case-sensitive, `SettingsScreen.tsx`).
- `AndroidManifest.xml` is unchanged. `BLUETOOTH_CONNECT` is already declared (line 47).
- APK version: `versionCode 14`, `versionName "2.3"` (`apps/pos/android/app/build.gradle:24-25`).
- No OTA journal-guard path is touched (`scripts/lib/ota-journal-guard.sh`), so no `OTA_JOURNAL_CHANGE_ACK` is needed.
- The web and browser POS keep `NoopTransport`. iOS (if ever built) keeps BLE only.
- **Review tier: Opus.** The plugin shares the Capacitor plugin thread with `OutboxJournal`. A blocking call there would stall journal writes, so this sits next to the offline outbox.
- **Owner go-ahead needed for:** the push to `prod-hardening`, the APK build, the install, and any test sale.

## Review Focus

Each of these failure modes gets a test, or a device check, in the task named:

1. **Printer off or out of range:** within about 11 s the user sees "Gagal mencetak: printer tidak menjawab…". The sale is already saved, and the app stays responsive while it waits: the cart, sync and the next sale do not freeze. Mapping test in Task 1; the separate thread in Task 4; the device check in Task 5.
2. **Long receipt:** a long or multi-copy receipt prints to the last line. The socket must not close before the bytes leave the tablet. `drainDelayMs` tests in Task 1; reprint the longest History order in Task 5.
3. **Printer chosen before the update:** it keeps printing without re-pairing. The stored id is the MAC from the BLE plugin, and its letter case may differ from the classic list. Case-insensitive lookup test in Task 3.
4. **Bluetooth off or permission denied:** shows a red "Gagal…" message, not a crash or a SecurityException. Mapping tests in Task 1; Java reject codes in Task 4; Bluetooth-off check in Task 5 (the owner toggles it).
5. **Two prints back to back:** auto-print followed at once by "Cetak Ulang", or `copies` 2. Neither cuts the other off. Serialization test in Task 3; Java `connect` closes any open socket first in Task 4.

---

### Task 1: Pure helpers: link choice, drain delay, base64, error copy

**Files:**
- Create: `packages/printer/src/classicTypes.ts`, `packages/printer/src/linkChoice.ts`, `packages/printer/src/printerError.ts`
- Test: `packages/printer/src/linkChoice.test.ts`, `packages/printer/src/printerError.test.ts`

**Interfaces:**
- Produces, in `classicTypes.ts`:
  - `type ClassicDeviceType = 'classic' | 'le' | 'dual' | 'unknown'`
  - `interface ClassicBondedDevice { address: string; name: string | null; type: ClassicDeviceType; hasSpp: boolean }`
  - `const CLASSIC_ERROR_CODES = ['BT_OFF','PERMISSION_DENIED','NOT_BONDED','CONNECT_TIMEOUT','CONNECT_FAILED','NOT_CONNECTED','WRITE_FAILED'] as const`
  - `type ClassicErrorCode = (typeof CLASSIC_ERROR_CODES)[number]`
- Produces, in `linkChoice.ts`:
  - `chooseLink(dev: ClassicBondedDevice | undefined): 'spp' | 'ble'`
  - `findBonded(devices: ClassicBondedDevice[], deviceId: string): ClassicBondedDevice | undefined`. Matches case-insensitively.
  - `drainDelayMs(bytesWritten: number): number`
  - `toBase64(bytes: Uint8Array): string`
- Produces, in `printerError.ts`:
  - `printerErrorMessage(err: unknown): string`

- [ ] **Step 1: Write the failing tests**
  - **`chooseLink`:**
    - `{type:'dual', hasSpp:true}` (the RPP02N case) → `'spp'`
    - `{type:'classic', hasSpp:false}` → `'spp'`
    - `{type:'le', hasSpp:false}` → `'ble'`
    - `{type:'dual', hasSpp:false}` → `'ble'`
    - `{type:'unknown', hasSpp:false}` → `'ble'`
    - `undefined` → `'ble'`
  - **`findBonded`:** `findBonded([{address:'86:67:7A:7E:30:CB',…}], '86:67:7a:7e:30:cb')` returns that device. An unknown id → `undefined`.
  - **`drainDelayMs`:** `0`→`0`, `1`→`301`, `800`→`400`, `100000`→`3000`.
  - **`toBase64`:** `toBase64(new Uint8Array([27,64]))` → `'G0A='`. A 100 000-byte array round-trips through `atob`, which proves there's no argument-length overflow.
  - **`printerErrorMessage`** (exact strings):

    | Input | Output |
    |---|---|
    | `{code:'CONNECT_TIMEOUT'}`, or any message matching `/timeout/i` (the BLE plugin's "Connection timeout.") | `Gagal mencetak: printer tidak menjawab. Pastikan printer menyala, ada kertas, dan dekat dengan tablet.` |
    | `{code:'CONNECT_FAILED'}` | `Gagal mencetak: tidak bisa tersambung ke printer. Matikan lalu nyalakan printer, lalu coba lagi.` |
    | `{code:'WRITE_FAILED'}` or `{code:'NOT_CONNECTED'}` | `Gagal mencetak: sambungan ke printer terputus. Coba cetak ulang.` |
    | `{code:'BT_OFF'}` | `Gagal mencetak: Bluetooth tablet mati. Nyalakan Bluetooth lalu coba lagi.` |
    | `{code:'PERMISSION_DENIED'}` | `Gagal mencetak: izin Bluetooth ditolak. Izinkan "Perangkat di sekitar" untuk aplikasi POS di Pengaturan Android.` |
    | `{code:'NOT_BONDED'}` | `Gagal mencetak: printer belum dipasangkan di Pengaturan Bluetooth tablet.` |
    | A message that already starts with `Gagal` | unchanged |
    | `new Error('Printer belum dipilih')` | `Gagal mencetak: Printer belum dipilih` |
    | a non-Error | `Gagal mencetak` |
  - One assertion that every output above starts with `Gagal`.
- [ ] **Step 2: Run them and see them fail.** Run: `corepack pnpm --filter @mandalika/printer test`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - `chooseLink` returns `'spp'` when `dev?.hasSpp || dev?.type === 'classic'`, otherwise `'ble'`.
  - `drainDelayMs` returns `0` when `bytesWritten <= 0`, otherwise `Math.min(3000, 300 + Math.ceil(bytesWritten / 8))`.
  - `toBase64` builds the binary string in 8192-byte slices, then calls `btoa`.
- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(printer): link choice, drain delay and Indonesian print-error copy for Bluetooth Classic`

### Task 2: `ClassicPrinter` JS bridge and `ClassicSppTransport`

**Files:**
- Create: `packages/printer/src/classicPlugin.ts`, `packages/printer/src/classic.ts`
- Test: `packages/printer/src/classic.test.ts`, which mocks `./classicPlugin`.

**Interfaces:**
- Consumes from Task 1: `ClassicBondedDevice`, `drainDelayMs`, `toBase64`.
- Produces, in `classicPlugin.ts`:
  - `interface ClassicPrinterPlugin`, with these methods:
    - `listBonded(): Promise<{ devices: ClassicBondedDevice[] }>`
    - `connect(o: { address: string; timeoutMs: number }): Promise<void>`
    - `write(o: { data: string /* base64 */ }): Promise<void>`
    - `disconnect(o: { drainMs: number }): Promise<void>`
  - `const ClassicPrinter = registerPlugin<ClassicPrinterPlugin>('ClassicPrinter')`, with no web implementation, the same as `packages/sync/src/journalPlugin.ts:48`.
- Produces, in `classic.ts`: `class ClassicSppTransport implements PrinterTransport`, with `kind: 'android-spp'`.
  - `connect(deviceId)` calls `ClassicPrinter.connect({ address: deviceId, timeoutMs: 10000 })`.
  - `write(payload)` calls `ClassicPrinter.write({ data: toBase64(payload) })` once per call and adds `payload.length` to a byte counter.
  - `disconnect()` calls `ClassicPrinter.disconnect({ drainMs: drainDelayMs(counter) })`, then resets the counter.
  - `pickDevice()` returns `null`: classic printers are paired in Android Settings.
  - `listBonded()` maps the plugin list to `PrinterDevice` (`name ?? 'Perangkat'`).
  - `isAvailable()` resolves `true` when `listBonded` succeeds, `false` when it throws.
- Modify `packages/printer/src/transport.ts`: `PrinterKind = 'capacitor-ble' | 'android-spp' | 'bluetooth-auto' | 'none'`.

- [ ] **Step 1: Write the failing tests**
  - `connect('86:67:7A:7E:30:CB')` → plugin `connect` called with `{address:'86:67:7A:7E:30:CB', timeoutMs:10000}`.
  - `write([27,64])` → plugin `write` called with `{data:'G0A='}`.
  - After writes of 500 and 300 bytes, `disconnect()` → plugin `disconnect` called with `{drainMs: 400}`. A second `disconnect()` with no writes in between → `{drainMs: 0}`.
  - The plugin's `connect` rejects with `{code:'CONNECT_TIMEOUT'}` → the transport rejects with the same `code`. Mapping to copy happens in Task 3.
- [ ] **Step 2: Run them and see them fail.** Run: `corepack pnpm --filter @mandalika/printer test`. Expected: FAIL.
- [ ] **Step 3: Implement** both files and the `PrinterKind` change.
- [ ] **Step 4: Run the tests and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(printer): ClassicPrinter bridge and SPP transport`

### Task 3: Auto routing, serialized print jobs, mapped errors, `supported` flag

**Files:**
- Create: `packages/printer/src/autoTransport.ts`, `packages/printer/src/printQueue.ts`
- Modify:
  - `packages/printer/src/print.ts`: `createTransport`, plus `printReceipt`, `printRecap` and `printTandaTerima`
  - `packages/printer/src/index.ts`: export `AutoBluetoothTransport`, `ClassicSppTransport`, `printerErrorMessage`
  - `apps/pos/src/printer.tsx:65`
- Test: `packages/printer/src/autoTransport.test.ts`, `packages/printer/src/print.test.ts`, `apps/pos/src/printer.test.tsx`

**Interfaces:**
- Consumes from Tasks 1 and 2: `chooseLink`, `findBonded`, `ClassicBondedDevice`, `ClassicSppTransport`, `ClassicPrinter`, `printerErrorMessage`.
- Produces: `class AutoBluetoothTransport implements PrinterTransport`.
  - Shape: `kind: 'bluetooth-auto'`, built by `constructor(ble: PrinterTransport, spp: PrinterTransport, lookupBonded: () => Promise<ClassicBondedDevice[]>)`.
  - `connect(deviceId)` calls `lookupBonded()` (a rejection counts as `[]`), then `chooseLink(findBonded(list, deviceId))`, then connects that delegate and remembers it as active.
  - `write` and `disconnect` go to the active delegate. `write` with no active delegate throws `new Error('Printer belum tersambung')`. `disconnect` clears the active delegate.
  - `pickDevice`, `listBonded` and `isAvailable` delegate to `ble`, so the Settings list is unchanged.
- Produces: `runExclusive<T>(fn: () => Promise<T>): Promise<T>`, a module-level promise chain. A rejected job does not block the next one.
- Changes `createTransport()`:
  - `Capacitor.getPlatform() === 'android'` → `new AutoBluetoothTransport(new CapacitorBleTransport(), new ClassicSppTransport(), async () => (await ClassicPrinter.listBonded()).devices)`
  - other native platforms → `CapacitorBleTransport`
  - web → `NoopTransport`
- Changes the three print functions: each runs its whole connect → write → disconnect inside `runExclusive`. Any failure is rethrown as `new Error(printerErrorMessage(e))`.
- Changes `printer.tsx:65` to `const supported = transportRef.current.kind !== 'none'`.

- [ ] **Step 1: Write the failing tests**
  - **`autoTransport.test.ts`** (fake `ble` and `spp` transports recording calls):
    - The lookup returns `{address:'86:67:7A:7E:30:CB', type:'dual', hasSpp:true}` and we connect `'86:67:7a:7e:30:cb'` → `spp.connect` is called and `ble.connect` is not. The following `write` and `disconnect` go to `spp`.
    - An LE-only device → `ble`.
    - The lookup rejects → `ble`.
    - After `disconnect`, a new `connect` re-runs the lookup.
    - `write` before `connect` rejects with `'Printer belum tersambung'`.
    - When the delegate's `connect` rejects, nothing is left active, so a following `write` rejects with `'Printer belum tersambung'`.
  - **`print.test.ts`:**
    - **Serialization:** two overlapping `printReceipt` calls on one recording transport (whose `write` waits 20 ms) give the call order `connect, write, disconnect, connect, write, disconnect`.
    - **Error mapping:** a transport whose `connect` rejects with `new Error('Connection timeout.')` makes `printReceipt` reject with the timeout copy from Task 1.
    - **Queue recovery:** after one failed job, the next job still runs.
    - **`createTransport()` per platform**, with `vi.mock('@capacitor/core')`: `android` → kind `bluetooth-auto`, `ios` → `capacitor-ble`, `web` → `none`.
  - **`apps/pos/src/printer.test.tsx`**, with `@mandalika/printer` and `@mandalika/sync` mocked: `createTransport` returns kind `bluetooth-auto` → `usePrinter().supported === true`; kind `none` → `false`.
- [ ] **Step 2: Run them and see them fail.** Run:
  - `corepack pnpm --filter @mandalika/printer test`
  - `corepack pnpm --filter @mandalika/pos exec vitest run src/printer.test.tsx`

  Expected: FAIL.
- [ ] **Step 3: Implement** the modules and edits above.
- [ ] **Step 4: Run them and see them pass, then run the wider checks.** Same commands, then:
  - the full POS suite: `corepack pnpm --filter @mandalika/pos test`
  - the typechecks: `corepack pnpm --filter @mandalika/printer exec tsc --noEmit` and `corepack pnpm --filter @mandalika/pos exec tsc -p tsconfig.json --noEmit`

  Expected: all PASS, with the existing ESC/POS tests unchanged.
- [ ] **Step 5: Commit.** `feat(printer): route bonded serial-port printers to SPP, serialize print jobs, Indonesian print errors`

### Task 4: Native `ClassicPrinterPlugin` and APK 2.3

**Files:**
- Create: `apps/pos/android/app/src/main/java/com/mandalika/pos/ClassicPrinterPlugin.java`
- Modify:
  - `apps/pos/android/app/src/main/java/com/mandalika/pos/MainActivity.java:23-25`: add `registerPlugin(ClassicPrinterPlugin.class);` next to the `OutboxJournalPlugin` line, before `super.onCreate`.
  - `apps/pos/android/app/build.gradle:24-25`: `versionCode 14`, `versionName "2.3"`.

**Interfaces:**
- Consumes the JS contract from Task 2: method names, option keys, resolve values and the `ClassicErrorCode` reject codes.
- Produces the native side of that contract.

**Requirements** (the implementer writes the body):
- **Annotation:** `@CapacitorPlugin(name = "ClassicPrinter", permissions = { @Permission(alias = "connect", strings = { Manifest.permission.BLUETOOTH_CONNECT }) })`.
- **Threading:** a private `ExecutorService` from `Executors.newSingleThreadExecutor()`. Every `@PluginMethod` hands its work to this executor and resolves or rejects the `PluginCall` from there. Nothing blocking runs on the Capacitor `CapacitorPlugins` thread, which is shared with `OutboxJournal` (`Bridge.java:138`).
- **Permission:** on `Build.VERSION.SDK_INT >= 31`, when `getPermissionState("connect") != PermissionState.GRANTED`, call `requestPermissionForAlias("connect", call, "afterConnectPermission")`.
  - The `@PermissionCallback` re-dispatches by `call.getMethodName()`.
  - If still denied → `call.reject("Bluetooth permission denied", "PERMISSION_DENIED")`.
  - A `SecurityException` anywhere is also rejected with `PERMISSION_DENIED`.
- **Adapter:** if `BluetoothAdapter` is null or not enabled, reject with `BT_OFF`.
- **`listBonded`:** resolves `{ devices: [{ address, name, type, hasSpp }] }`.
  - `type` maps from `getType()`: 1 → `classic`, 2 → `le`, 3 → `dual`, anything else → `unknown`.
  - `hasSpp` is true when `getUuids()`, which may be null, contains the SPP UUID.
- **`connect`:**
  1. Closes any open socket first.
  2. Finds the bonded device with `address.equalsIgnoreCase`; if none, rejects with `NOT_BONDED`.
  3. Calls `adapter.cancelDiscovery()` only when `BLUETOOTH_SCAN` is granted (or the SDK is below 31), and ignores a `SecurityException`.
  4. Tries `createRfcommSocketToServiceRecord(SPP)`. On `IOException` it tries `createInsecureRfcommSocketToServiceRecord(SPP)` within the remaining time.
  5. Enforces `timeoutMs` with a scheduled `socket.close()`. If the deadline closed the socket → reject with `CONNECT_TIMEOUT`; any other failure → `CONNECT_FAILED`.
- **`write`:** with no open socket, rejects with `NOT_CONNECTED`. Otherwise it decodes with `Base64.decode(data, Base64.DEFAULT)`, then calls `out.write` and `out.flush()`. On `IOException` it closes the socket and rejects with `WRITE_FAILED`.
- **`disconnect`:** sleeps `drainMs` (on the executor), closes the stream and the socket, then resolves. It always resolves, even with nothing open.
- **`handleOnDestroy`:** closes the socket and shuts the executor down.

- [ ] **Step 1: Compile check.**
  - If a JDK and the Android SDK are available locally: `cd apps/pos/android && ./gradlew :app:compileReleaseJavaWithJavac`. Expected: BUILD SUCCESSFUL.
  - If not, say so in the PR. The `android-release.yml` build in Task 5 is then the compile proof.
- [ ] **Step 2: Contract review.** Diff the Java method names, option keys and reject codes against `classicPlugin.ts` and `CLASSIC_ERROR_CODES`, one by one, and list the pairs in the PR body.
- [ ] **Step 3: Commit.** `feat(pos-android): ClassicPrinter RFCOMM plugin on its own thread; APK 2.3 (versionCode 14)`

### Task 5: Release and on-device proof (owner go-ahead at each gated step)

**Files:**
- Modify: `HANDOFF.md` (Progress board), `docs/qa/codex-deliberate-leftovers.md` (section C, "No paired printer")

- [ ] **Step 1: Review and gate.**
  1. Opus reviews the branch.
  2. Merge no-ff onto `origin/prod-hardening` and push `gate/<name>`.
  3. All 5 CI workflows must pass.
  4. Push behind a `[CF-Pages-Skip] [skip ci]` HANDOFF commit (owner go-ahead).
- [ ] **Step 2: Build the APK (owner go-ahead).**
  - Run `gh workflow run android-release.yml --ref prod-hardening -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app -f release_type=test`.
  - Expected: success and a `mandalika-pos-2.3-build14-test-<sha>` artifact. The manifest's sha256 must match the download (`curl` the artifact; `gh run download` times out on TLS here).
- [ ] **Step 3: Install (owner go-ahead).**
  - First confirm 0 pending sales and an empty cart.
  - Run `adb install -r`. Expected: `dumpsys package` shows 2.3/14, and login and shift are kept.
- [ ] **Step 4: Device checks with the RPP02N.** The owner confirms the paper.
  1. Settings still shows the printer section, with "RPPO2N" as the paired printer.
  2. "Tes Cetak" prints a full receipt.
     - logcat has no `BluetoothGatt` connect to `30:CB`. The RFCOMM connect shows up.
  3. Reprint the longest order in History: every line and the footer print.
  4. With the printer switched off, "Tes Cetak" shows the timeout copy in red within about 11 s. While it waits, add a product to the cart: the cart answers at once.
  5. The owner turns Bluetooth off: the BT_OFF copy appears. Turn it back on and printing works.
  6. A test sale with the QA product (owner approval) auto-prints. "Cetak Ulang" at once prints a second full receipt. Refund the sale to zero.
- [ ] **Step 5: Record.**
  - Update HANDOFF and the leftovers doc, including the fleet note: OTAs now target versionCode 14, so tablets on APK 2.2 get no further OTAs until they install 2.3.
  - Not covered: the BLE printer path (no BLE printer available) and iOS.
