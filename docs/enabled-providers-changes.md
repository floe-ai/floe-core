# Enabled Providers — Implementation Changes

> **Schema change already applied:** `floe/schemas/config.json` now includes
> `enabledProviders` as a required property (array of `"codex" | "claude" | "copilot"`,
> minItems 1, uniqueItems true).

---

## 1. `floe/bin/floe.ts` — Required Changes

### 1a. FloeConfig interface (~line 95)

Add the `enabledProviders` field:

```diff
 interface FloeConfig {
   defaultProvider: string;
+  enabledProviders?: string[];
   configured?: boolean;
   roles?: {
     planner?: { provider?: string; model?: string; thinking?: string };
     implementer?: { provider?: string; model?: string; thinking?: string };
     reviewer?: { provider?: string; model?: string; thinking?: string };
   };
 }
```

> The field is optional in the TS interface because existing configs may lack it.
> Pre-flight will enforce it at runtime.

---

### 1b. resolveProvider() return type + guard (~line 115-146)

Add an optional `error` field to the return type and a post-resolution guard:

```diff
-function resolveProvider(role: string, args: Record<string, any>, config: FloeConfig | null): {
-  provider: string;
-  model?: string;
-  thinking?: string;
-} {
+function resolveProvider(role: string, args: Record<string, any>, config: FloeConfig | null): {
+  provider: string;
+  model?: string;
+  thinking?: string;
+  error?: string;
+} {
   // 1. CLI flag
   if (args.provider) return { provider: args.provider };

   // 2. Environment variable
   if (process.env.FLOE_PROVIDER) return { provider: process.env.FLOE_PROVIDER };

   // 3. Config role-specific
   if (config?.roles) {
     const roleConfig = (config.roles as any)[role];
     if (roleConfig?.provider) {
-      return { provider: roleConfig.provider, model: roleConfig.model, thinking: roleConfig.thinking };
+      const resolved = { provider: roleConfig.provider, model: roleConfig.model, thinking: roleConfig.thinking };
+      return validateEnabledProvider(resolved, config);
     }
   }

   // 4. Config default
   if (config?.defaultProvider) {
     const roleConfig = config.roles ? (config.roles as any)[role] : undefined;
-    return {
+    const resolved = {
       provider: config.defaultProvider,
       model: roleConfig?.model,
       thinking: roleConfig?.thinking,
     };
+    return validateEnabledProvider(resolved, config);
   }

   // 5. No provider configured
   return { provider: "" };
 }
+
+/** Validate resolved provider against the enabledProviders allowlist. */
+function validateEnabledProvider(
+  resolved: { provider: string; model?: string; thinking?: string },
+  config: FloeConfig | null,
+): { provider: string; model?: string; thinking?: string; error?: string } {
+  if (config?.enabledProviders && resolved.provider) {
+    if (!config.enabledProviders.includes(resolved.provider)) {
+      return {
+        provider: "",
+        error: `Provider '${resolved.provider}' is not enabled for this repo. Enabled: [${config.enabledProviders.join(", ")}]. Update .floe/config.json or run: bun run .floe/bin/floe.ts configure`,
+      };
+    }
+  }
+  return resolved;
+}
```

**Callers that must check for `error`:**

In `launchWorker()` (~line 288), after line 293:

```diff
   const config = loadConfig(projectRoot);
   const resolved = resolveProvider(role, args, config);
+  if (resolved.error) return { ok: false, error: resolved.error };
   const { adapter, error } = getAdapter(resolved.provider);
```

In `manageFeaturePair()` (~line 534), after resolving both providers (~line 546-549):

```diff
   const implResolved = args["implementer-provider"]
     ? { provider: args["implementer-provider"] }
     : resolveProvider("implementer", args, config);
   const revResolved = args["reviewer-provider"]
     ? { provider: args["reviewer-provider"] }
     : resolveProvider("reviewer", args, config);
+
+  if (implResolved.error) return { ok: false, error: implResolved.error };
+  if (revResolved.error) return { ok: false, error: revResolved.error };
```

---

### 1c. configure command — enabledProviders step (~line 703)

Insert a new multiselect step **before** the default provider selection (before
the current step 1 at ~line 737). The default provider selection should then
only offer providers from the enabled set.

#### Interactive mode (after `p.intro(...)` at line 729):

```typescript
  // 0. Enabled providers — which providers can this repo use?
  const enabledProviders = await p.multiselect({
    message: "Which providers do you want to enable for this repo?",
    options: PROVIDERS.map(prov => ({
      value: prov,
      label: prov.charAt(0).toUpperCase() + prov.slice(1),
      hint: PROVIDER_HINTS[prov],
    })),
    initialValues: [detectedDefault],
    required: true,
  });
  handleCancel(enabledProviders);

  if ((enabledProviders as string[]).length === 0) {
    p.log.error("You must enable at least one provider.");
    process.exit(1);
  }
```

Then **modify** the default provider selection to only offer enabled providers:

```diff
   const defaultProvider = await p.select({
     message: "Which provider should workers use by default?",
-    initialValue: detectedDefault,
-    options: PROVIDERS.map(prov => ({
+    initialValue: (enabledProviders as string[]).includes(detectedDefault)
+      ? detectedDefault
+      : (enabledProviders as string[])[0],
+    options: (enabledProviders as string[]).map(prov => ({
       value: prov,
       label: prov.charAt(0).toUpperCase() + prov.slice(1),
       hint: PROVIDER_HINTS[prov],
     })),
   });
```

Save `enabledProviders` into the config object (~line 811):

```diff
-  const config: FloeConfig = { defaultProvider: defaultProvider as string, configured: true, roles: {} };
+  const config: FloeConfig = {
+    defaultProvider: defaultProvider as string,
+    enabledProviders: enabledProviders as string[],
+    configured: true,
+    roles: {},
+  };
```

Also constrain the per-role provider selection (~line 825-833) to only enabled
providers:

```diff
       const roleProvider = await p.select({
         message: `Provider for ${role}?`,
         initialValue: defaultProvider as string,
-        options: PROVIDERS.map(prov => ({
+        options: (enabledProviders as string[]).map(prov => ({
           value: prov,
           label: prov.charAt(0).toUpperCase() + prov.slice(1),
           hint: prov === (defaultProvider as string) ? "current default" : PROVIDER_HINTS[prov],
         })),
       });
```

#### Non-interactive mode (~line 707):

Add `--enabled-providers` flag support:

```diff
   if (nonInteractive) {
     const defaultProvider = args["default-provider"];
     if (!defaultProvider) return { ok: false, error: "configure --non-interactive requires --default-provider <claude|codex|copilot>" };
     if (!PROVIDERS.includes(defaultProvider as any)) return { ok: false, error: `Invalid provider: ${defaultProvider}. Must be: ${PROVIDERS.join(", ")}` };

-    const config: FloeConfig = { defaultProvider, configured: true };
+    // --enabled-providers comma-separated, defaults to just the default provider
+    const rawEnabled = args["enabled-providers"] as string | undefined;
+    const enabledProviders = rawEnabled
+      ? rawEnabled.split(",").map(s => s.trim()).filter(Boolean)
+      : [defaultProvider];
+    for (const ep of enabledProviders) {
+      if (!PROVIDERS.includes(ep as any)) return { ok: false, error: `Invalid enabled provider: ${ep}. Must be: ${PROVIDERS.join(", ")}` };
+    }
+    if (!enabledProviders.includes(defaultProvider)) {
+      return { ok: false, error: `Default provider '${defaultProvider}' must be in enabledProviders [${enabledProviders.join(", ")}]` };
+    }
+
+    const config: FloeConfig = { defaultProvider, enabledProviders, configured: true };
```

---

### 1d. show-config command (~line 929)

Add `enabledProviders` to the output:

```diff
 async function showConfig(_args: Record<string, any>) {
   const config = loadConfig(projectRoot);
   if (!config) {
     return { ok: false, error: "No .floe/config.json found. Run: bun run .floe/bin/floe.ts configure" };
   }
-  return { ok: true, config };
+  return {
+    ok: true,
+    config,
+    enabledProviders: config.enabledProviders ?? "NOT SET (run configure)",
+  };
 }
```

---

### 1e. Pre-flight checks in manageFeaturePair and launchWorker

In **manageFeaturePair()** (~line 541), immediately after `loadConfig`:

```diff
   const config = loadConfig(projectRoot);
+
+  // Pre-flight: enabledProviders must be set
+  if (!config?.enabledProviders) {
+    return { ok: false, error: "Provider allowlist not set. Run: bun run .floe/bin/floe.ts configure" };
+  }
```

In **launchWorker()** (~line 292), immediately after `loadConfig`:

```diff
   const config = loadConfig(projectRoot);
+
+  // Pre-flight: enabledProviders must be set
+  if (!config?.enabledProviders) {
+    return { ok: false, error: "Provider allowlist not set. Run: bun run .floe/bin/floe.ts configure" };
+  }
+
   const resolved = resolveProvider(role, args, config);
```

---

## 2. `floe/roles/foreman.md` — Required Changes

### Pre-flight Configuration section (~line 37-48)

Replace the current steps 1-3 with:

```markdown
## Pre-flight Configuration

After reading runtime state (step 1 of startup), check provider configuration before any pipeline work:

1. Check config: `bun run .floe/bin/floe.ts show-config`
2. If config is missing or `configured` is `false`:
   - Tell the user: "Provider configuration hasn't been completed yet. Let's set up your models before we start."
   - Run: `bun run .floe/bin/floe.ts configure`
   - This is a one-time step — once complete, it won't trigger again
3. If config exists but `enabledProviders` is not set:
   - Tell the user: "Provider allowlist hasn't been configured. Let's set which providers are enabled for this repo."
   - Run: `bun run .floe/bin/floe.ts configure`
4. Confirm that all role-specific providers (if any) are within the enabled set. If a role maps to a disabled provider, stop and tell the user.
5. If config exists and `configured` is `true` (or the field is absent — backward-compatible) and `enabledProviders` is set: proceed normally

This check happens BEFORE any pipeline launch. The Foreman never launches workers without valid provider configuration.
```

---

## 3. `.floe/config.json` — Required Changes

Add the `enabledProviders` field to match the current default provider:

```diff
 {
   "defaultProvider": "copilot",
+  "enabledProviders": ["copilot"],
   "roles": {
     "planner": {
       "model": "claude-sonnet-4"
```

---

## Summary of changes by file

| File | Status | Action |
|------|--------|--------|
| `floe/schemas/config.json` | ✅ DONE | Added `enabledProviders` property + required |
| `floe/bin/floe.ts` | 📋 Described | 5 change areas: interface, resolveProvider, configure, show-config, pre-flight |
| `floe/roles/foreman.md` | 📋 Described | Updated pre-flight section with steps 3-5 |
| `.floe/config.json` | 📋 Described | Add `"enabledProviders": ["copilot"]` |
