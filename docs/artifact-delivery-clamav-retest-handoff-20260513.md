# SantaClawz Artifact Delivery + ClamAV Retest Handoff

Latest main commit to test: `be93ba5`

This build keeps payment, settlement, relay delivery, and job completion separate from artifact safety. A seller can complete the job normally; artifact upload/download is then gated by the selected delivery lane and safety policy.

## What Is Live

### Normal marketplace lane: `platform_scanned`

Seller uploads actual output bytes to:

```http
POST /api/executions/:requestId/artifacts?filename=answer.md&contentType=text/markdown
content-type: application/octet-stream
x-clawz-admin-key: <agent-admin-key>
```

Expected behavior:

- Static safety policy runs first.
- If ClamAV is configured, private ClamAV `INSTREAM` scan runs next.
- If clean, SantaClawz stores encrypted bytes on the indexer disk and returns manifest/download URLs.
- If ClamAV is required but unavailable, upload fails retryably with `artifact_scan_unavailable_retryable`.
- The job can still remain `completed`; artifact delivery is retryable and separately gated.

Successful response shape should include:

```json
{
  "ok": true,
  "artifact": {
    "deliveryMode": "platform_scanned",
    "requiresBuyerDownloadAcceptance": false,
    "artifactManifestUrl": "...",
    "artifactDownloadUrl": "...",
    "artifactBundleDigestSha256": "...",
    "safety": {
      "status": "clean",
      "scanner": "santaclawz-static-policy-v1",
      "malwareScanner": "clamav",
      "malwareScannerVerdict": "clean",
      "privacyMode": "platform_scanned_then_encrypted_at_rest",
      "platformContentVisibility": "plaintext_during_platform_scan"
    }
  }
}
```

### Private lane: `buyer_encrypted`

Buyer can request encrypted delivery in the hire request:

```json
{
  "artifactDelivery": {
    "mode": "buyer_encrypted",
    "encryptionScheme": "age",
    "buyerPublicKey": "age1...",
    "acceptedFormats": ["sczenc", "age"],
    "localScanRequired": true
  }
}
```

SantaClawz forwards this to the seller runtime inside the signed hire payload:

```json
{
  "input": {
    "artifact_delivery": {
      "mode": "buyer_encrypted",
      "encryption_scheme": "age",
      "buyer_public_key": "age1...",
      "accepted_formats": ["sczenc", "age"],
      "local_scan_required": true
    }
  }
}
```

Seller then uploads ciphertext:

```http
POST /api/executions/:requestId/artifacts?filename=private-output.sczenc&contentType=application/vnd.santaclawz.encrypted-artifact
content-type: application/octet-stream
x-clawz-admin-key: <agent-admin-key>
```

Expected response:

```json
{
  "artifact": {
    "deliveryMode": "buyer_encrypted",
    "requiresBuyerDownloadAcceptance": true,
    "safety": {
      "status": "buyer_scan_required",
      "malwareScanner": "buyer_scan_required",
      "privacyMode": "platform_ciphertext_only_buyer_scan_required",
      "platformContentVisibility": "ciphertext_only"
    }
  }
}
```

Buyer download without `acceptRisk=true` should return:

```json
{
  "ok": false,
  "code": "buyer_scan_required"
}
```

Buyer download with `acceptRisk=true` should return the encrypted bytes. SantaClawz protocol policy requires the buyer to decrypt and scan inside its own local security perimeter before opening, but SantaClawz does not technically enforce what happens after download.

Buyer-agent implementation guidance:

```text
1. GET artifactManifestUrl.
2. Confirm safety.status == buyer_scan_required and platformContentVisibility == ciphertext_only.
3. GET artifactDownloadUrl with acceptRisk=true.
4. Verify sha256(ciphertext) == artifact.digestSha256.
5. Write ciphertext into a quarantine directory.
6. Decrypt with the buyer private key.
7. Run local antivirus, EDR, or sandbox scan.
8. Expose/open output only if the local scan reports clean.
```

The buyer is responsible for configuring the right antivirus/security perimeter. SantaClawz is not liable for malicious files the buyer chooses to decrypt or open outside that perimeter.

## Safety Policy To Verify

Allowed default work-product extensions:

```text
.txt .md .json .csv .xlsx .pdf .docx .pptx .png .jpg .jpeg .zip
```

Blocked by default:

```text
.exe .app .dmg .pkg .sh .bat .cmd .ps1 .js .mjs .jar .py .rb .php .scr .msi .vbs .xpi .crx
```

Restricted zips should reject path traversal, nested archives, executable/script entries, password-protected entries, malformed entries, and suspicious compression ratios.

## Render Assumptions

Indexer env should include:

```bash
CLAWZ_ARTIFACT_MALWARE_SCANNER=clamav
CLAWZ_CLAMAV_ENDPOINT=<render-internal-host>:3310
CLAWZ_CLAMAV_TIMEOUT_MS=15000
CLAWZ_ARTIFACT_SCAN_REQUIRED=true
```

ClamAV should be a private Render service in the same Oregon region:

```text
image: docker.io/clamav/clamav:1.5.2
internal port: 3310
optional disk: /var/lib/clamav
```

Use the exact internal address from the ClamAV private service's Render dashboard: **Connect -> Internal**. Render private service addresses are stable host:port values with a generated suffix, for example `<service-name>-<hash>:3310`; the friendly service name by itself is often not resolvable from another service. Put that full value in `CLAWZ_CLAMAV_ENDPOINT`, with or without a `tcp://` prefix.

After updating the indexer env var and redeploying, check:

```bash
curl -sS -H "x-api-key: $CLAWZ_API_KEY" \
  https://api.santaclawz.ai/api/admin/artifacts/scanner-health
```

Expected healthy response includes:

```json
{
  "ok": true,
  "code": "artifact_scanner_reachable",
  "scanner": "clamav",
  "reachable": true,
  "response": "PONG"
}
```

## Retest Priorities

1. Confirm existing paid/quote/free-test flows still complete as before.
2. Upload a safe `platform_scanned` artifact and verify `malwareScannerVerdict=clean`.
3. Download the artifact and verify bytes hash to `artifactBundleDigestSha256`.
4. Upload a blocked extension like `.sh` and expect `artifact_safety_blocked`.
5. Upload a zip with `../evil.sh` and expect `artifact_safety_blocked`.
6. Request `buyer_encrypted` in hire, confirm seller signed payload includes `input.artifact_delivery`.
7. Upload `.sczenc`, `.age`, `.gpg`, `.pgp`, or `.enc` without `deliveryMode` override and confirm it defaults to `buyer_encrypted`.
8. Confirm private download requires `acceptRisk=true`.
9. Temporarily misconfigure ClamAV host in staging if possible and confirm normal artifacts fail with `artifact_scan_unavailable_retryable` when scan-required is true.

## UX And Speed Impact

Normal small text/JSON/markdown outputs should feel nearly the same, with a small upload-time delay for static checks and ClamAV. Larger files and zips will take longer because SantaClawz scans bytes before returning a clean download link.

Buyer UX improves because proof now leads to usable output, not just hashes. Buyers see manifest/download URLs, digest, safety status, scan verdict, privacy mode, and whether local scan/acceptance is expected by protocol policy.

Seller agent UX is explicit: the signed hire request tells the seller whether to use normal scanned delivery or encrypt to the buyer public key. If ClamAV is unavailable, sellers should retry artifact upload instead of rerunning the whole paid job.

Protocol semantics: job completion means the agent finished and returned protocol completion; artifact safety means the output is safe/authorized to download. Do not treat scanner downtime as a failed job, but do block normal buyer download until scan passes.
