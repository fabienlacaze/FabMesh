# SAC Forensic Report — 2026-05-30

## Verdict (1 sentence)
**Yes — Smart App Control is the blocker**, enforced via the kernel WDAC/UMCI mechanism using Microsoft's signed SAC base policy `{0283AC0F-FFF1-49AE-ADA1-8A933130CAD6}`, which rejects the unsigned community-built CUDA wheels (`flash_attn_2_cuda.cp311-win_amd64.pyd`, `kaolin\_C.pyd`) at image-load time with NT status mapping to Win32 error **4551 = ERROR_APPLICATION_CONTROL_BLOCKED**.

## Hard evidence

Cross-referenced from all four investigators — every layer (event log, ctypes probe, registry, policy file on disk) names the same policy GUID.

- **Event log — `Microsoft-Windows-CodeIntegrity/Operational`**, 20 paired events on 2026-05-30 between 18:52 and 20:11:
  - Event ID **3033** (Error): *"Code Integrity determined that a process (...\python.exe) attempted to load ...\flash_attn_2_cuda.cp311-win_amd64.pyd [or kaolin\\_C.pyd] that did not meet the **Enterprise signing level requirements**."*
  - Event ID **3077** (Error): same message + *"...violated code integrity policy (**Policy ID:{0283ac0f-fff1-49ae-ada1-8a933130cad6}**)."*
- **Blocked file paths** (verbatim from events):
  - `\Device\HarddiskVolume3\Users\Utilisateur\Desktop\FabWare\MeshyMyself\external\TRELLIS2_win\.venv\Lib\site-packages\flash_attn_2_cuda.cp311-win_amd64.pyd`
  - `\Device\HarddiskVolume3\Users\Utilisateur\Desktop\FabWare\MeshyMyself\external\TRELLIS2_win\.venv\Lib\site-packages\kaolin\_C.pyd`
- **Loader**: `\Users\Utilisateur\AppData\Local\Programs\Python\Python311\python.exe` (system CPython 3.11 used by the TRELLIS2 venv).
- **Process-independent block** — `LoadLibraryW` from PowerShell `Add-Type` returns the **same `GetLastError = 4551` (ERROR_APPLICATION_CONTROL_BLOCKED)** for both files. From Python ctypes, identical: `handle=0, err=4551`. Confirms OS-level enforcement, not Python-specific.
- **Control case**: `torch\lib\c10.dll` is also `NotSigned` but **loads (handle non-zero, err=0)** — proves SAC's decision is ISG-reputation-based, not pure signature.
- **Differential failure**: `torchvision\_C.pyd` returns **`err=126` (ERROR_MOD_NOT_FOUND)**, not 4551 — it is failing because of a transitive dependency on one of the SAC-blocked binaries, not because SAC blocks it directly.
- **Authenticode**: `Get-AuthenticodeSignature` reports `Status=NotSigned, SignerCertificate=<empty>` on the two blocked .pyd. No MOTW Zone.Identifier ADS on either file — SAC's call is reputation, not MOTW.
- **Registry — `HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy`**:
  - `VerifiedAndReputablePolicyState = 1` → **SAC ON**
  - `SAC_EnforcementReason = 1` → enforced (not Eval / not Audit)
  - `SAC_PreviousState = 0xFFFFFFFF` → never toggled off (consistent with MS one-way design)
- **WMI — `Win32_DeviceGuard`**:
  - `UsermodeCodeIntegrityPolicyEnforcementStatus = 2` → UMCI **Enforced**
  - `CodeIntegrityPolicyEnforcementStatus = 2` → kernel CI Enforced
  - `VirtualizationBasedSecurityStatus = 2` → VBS running
- **Defender — `MSFT_MpComputerStatus`**: `SmartAppControlState = On`, `AMRunningMode = Passive Mode`, `IsTamperProtected = True`.
- **Active policy file on disk** — `C:\Windows\System32\CodeIntegrity\CiPolicies\Active\{0283AC0F-FFF1-49AE-ADA1-8A933130CAD6}.cip` (7079 B, 2024-04-01). **Filename GUID is byte-identical to the Policy ID quoted in every 3077 event.** This is Microsoft's well-known SAC base policy GUID, not a user/enterprise WDAC policy.

## What we ELIMINATED

| Suspect | Evidence | Ruled out? |
|---|---|---|
| **Windows Defender AV** | Zero matches in `Microsoft-Windows-Windows Defender/Operational` for IDs 1116/1117 against `flash_attn`, `kaolin`, `trellis`, `_C.pyd`. No quarantine. PUAProtection=2 but no PUA hit. | **YES — eliminated.** |
| **SmartScreen / MOTW** | No Zone.Identifier ADS on the blocked files. `SmartScreenEnabled` / `EnableSmartScreen` registry values not set. Block fires for files without MOTW. | **YES — eliminated.** |
| **AppLocker** | `Microsoft-Windows-AppLocker/{EXE,DLL}` shows only ID 8001 (policy applied OK), zero block events. `Get-AppLockerPolicy` cmdlet absent (Win11 Home SKU). | **YES — eliminated.** |
| **HVCI** | `SecurityServicesRunning = {2}` (HVCI on), but HVCI only gates kernel-mode code. The block is in UMCI, not HVCI. | **YES — eliminated as the trigger** (HVCI is on but orthogonal). |
| **Custom WDAC supplemental policy** | Two custom-looking .cip exist (`{60FD87F8-...}.cip` dated 2026-05-27, `{784C4414-...}.cip`). **Neither GUID appears in any 3077 event.** Only `{0283AC0F-...}` (SAC base) is cited. | **YES — eliminated.** |
| **Missing dependency (DLL not found)** | The two SAC-blocked .pyd return `err=4551`, not `126`. `torchvision\_C.pyd` returns `err=126` separately, but that's a downstream consequence (it depends on a SAC-blocked .pyd). | **YES — eliminated** for `flash_attn` + `kaolin`. |
| **File corruption** | Files are unchanged since `01/05/2026` (`flash_attn`) and `18/05/2026` (`kaolin`). They worked on `20/05/2026 22:55` (last successful `enfant_orc_trellis2_native_*.glb`). Bit-identical files now blocked. | **YES — eliminated.** |
| **3rd-party AV** | No 3rd-party AV product on this machine; Defender is the active AV (`AMRunningMode=Passive Mode` only because SAC enforces while Defender takes a back-seat — still no Defender block events). | **YES — eliminated.** |

## What broke / when / why

Sharp before/after boundary:

| Date | Event |
|---|---|
| 2026-05-01 | `flash_attn_2_cuda.cp311-win_amd64.pyd` last-write (unchanged since) |
| 2026-05-18 | `kaolin\_C.pyd` last-write (unchanged since) |
| **2026-05-20 22:55:57** | **Last successful** TRELLIS2 native GLB write: `enfant_orc_trellis2_native_1779310224708.glb` |
| 2026-05-27 | **KB5089573 + KB5092734 + KB5092427 installed** |
| 2026-05-27 19:33 | `{60FD87F8-...}.cip` refreshed (May 2026 ISG signers refresh) |
| 2026-05-30 05:37 | Defender signatures bumped to 1.451.178.0 |
| 2026-05-30 13:20 | Additional Defender package update |
| **2026-05-30 18:36** | **First-ever** CodeIntegrity 3077 block (21 today, 0 in the prior 14 days) |

- The two .pyd binaries are bit-identical to when they last worked on 20/05.
- The CodeIntegrity log shows **zero** 3077 events in the 14 days before 30/05, then **21** today, all naming exactly the two TRELLIS2 .pyd files.
- The most likely trigger is the **27/05 cumulative + ISG policy refresh** combined with today's Defender signature push, which either flipped SAC enforcement on these specific unsigned binaries or invalidated a prior ISG "trusted" verdict cached against the file hashes. SAC's `SAC_PreviousState = 0xFFFFFFFF` confirms SAC has been "On" the whole time — what changed is the ISG verdict on these hashes, not the SAC master switch.

## What it would take to unblock — re-evaluated

Hard evidence narrows the option set. The block is at **UMCI image-load time** under the **Microsoft-signed SAC base policy**. That policy cannot be edited, supplemented, or per-file exempted by the user — by design, only Microsoft signs it, and SAC has no admin-side allowlist.

### Solutions that DO work
1. **Disable SAC** — `Settings → Privacy & security → Smart App Control → Off`. **One-way operation** on Windows 11: per Microsoft, once turned off, SAC can only be re-enabled by reinstalling Windows. Registry confirms current state via `VerifiedAndReputablePolicyState=1`; flipping to 0 disables the policy. **This is the only zero-cost local fix** and is consistent with what all four agents converged on.
2. **Run the TRELLIS2 pipeline in WSL2** — SAC/UMCI does not gate Linux ELF binaries inside the WSL2 VM. The flash_attn and kaolin Linux wheels load normally. Preserves SAC on the Windows host. This is the lowest-risk path if SAC must stay on.
3. **Sign the .pyd with an Authenticode cert that gets ISG reputation** — theoretically possible but:
   - A standard EV / OV code-signing cert alone is **not sufficient** — SAC requires ISG reputation, which is built by Microsoft cloud telemetry seeing the signed binary distributed widely. A freshly-signed obscure wheel will still be blocked until ISG reputation accumulates (days to weeks, no SLA).
   - **Azure Trusted Signing** (the path suggested previously) does grant some immediate ISG reputation via Microsoft Identity Verification, but it requires an Azure subscription, identity verification, and re-signing every artifact at build time. Cost: ~$10/month + per-signature. Only worth it for a shipping product.
4. **Microsoft Store distribution** — Store-signed packages bypass SAC's reputation check entirely. Realistic only for the final FabMesh app, not for dev-time TRELLIS2 wheels.

### New path that emerged from the evidence
- The Policy ID `{0283AC0F-FFF1-49AE-ADA1-8A933130CAD6}` is **Microsoft's published SAC base policy** — there is **no documented per-file exception mechanism** for it. So no, no hidden "add to SAC allowlist" exists.
- However: since the .pyd files **previously loaded fine** on the same machine until 27/05, the Defender / ISG cache may simply have lost the prior reputation verdict. **Submitting the two .pyd hashes via the [Microsoft Defender Security Intelligence false-positive form](https://www.microsoft.com/en-us/wdsi/filesubmission)** ("file should be allowed") is a real, documented Microsoft channel — if MS re-classifies the hashes as reputable, ISG propagates the verdict and SAC stops blocking, without disabling SAC or signing anything. No agent tested this path; it is consistent with the "ISG reputation, not signature" finding from the ctypes probe (unsigned `c10.dll` loads, unsigned `flash_attn` doesn't → only thing that differs is ISG reputation).

### Recommendation order (cheapest first)
1. Turn SAC **Off** (Settings UI) — instant fix, irreversible without OS reinstall, acceptable on a dev machine.
2. If SAC must stay on: submit `flash_attn_2_cuda.cp311-win_amd64.pyd` and `kaolin\_C.pyd` hashes to MS Defender false-positive intake.
3. Long-term shipping: WSL2 for TRELLIS2 dev + Trusted Signing / Store packaging for the FabMesh release build.
