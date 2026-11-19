(() => {
  "use strict";

  const api = browser;
  const learnButton = document.getElementById("learn");
  const fillButton = document.getElementById("fill");
  const status = document.getElementById("status");
  const activity = document.getElementById("activity");
  const activityLabel = document.getElementById("activity-label");
  const getStarted = document.getElementById("get-started");
  const readyContent = document.getElementById("ready-content");
  const openAppButton = document.getElementById("open-app");
  const openSettingsButton = document.getElementById("open-settings");
  const openDebugLogButton = document.getElementById("open-debug-log");
  const closeDebugLogButton = document.getElementById("close-debug-log");
  const deleteDebugLogButton = document.getElementById("delete-debug-log");
  const copyDebugLogButton = document.getElementById("copy-debug-log");
  const emailDebugLogButton = document.getElementById("email-debug-log");
  const debugLogPanel = document.getElementById("debug-log-panel");
  const debugLogText = document.getElementById("debug-log-text");
  const DEBUG_LOG_KEY = "ume-extension-debug-log";
  const DEBUG_LOG_LIMIT = 64_000;
  const { t, plural } = UmeI18n;
  UmeI18n.localizeDocument(document);

  // "Filled 3 fields, including 1 AI match." English pluralizes both counts.
  function filledWithAI(total, aiFilled) {
    const key = total === 1 ? "filledWithAI_one" : `filledWithAI_other_${aiFilled === 1 ? "one" : "other"}`;
    return t(key, total, aiFilled);
  }

  const CONTENT_SCRIPT_FILES = ["lib/matcher.js", "lib/dom.js", "lib/date.js", "lib/phone.js", "content.js"];
  const AI_SCHEMA_KEYS = [
    "accessibleDescription", "accessibleName", "answerType", "autocomplete", "form", "group",
    "groupName", "id", "inputType", "kind", "label", "name", "options", "placeholder",
    "required", "section", "tableHeaders", "userLabel"
  ];
  let debugLoggingEnabled = false;
  let busy = false;
  let cachedAnswers = [];

  async function injectContentScript(tabId) {
    if (api.scripting?.executeScript) {
      await api.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: CONTENT_SCRIPT_FILES
      });
      return;
    }
    if (api.tabs.executeScript) {
      for (const file of CONTENT_SCRIPT_FILES) {
        await api.tabs.executeScript(tabId, { file, frameId: 0 });
      }
      return;
    }
    throw new Error(t("errNoOnDemand"));
  }

  async function ensureContentScript(tabId) {
    try {
      const response = await api.tabs.sendMessage(tabId, { type: "UME_PING" }, { frameId: 0 });
      if (response?.ready) return;
    } catch (_error) {
      // The script is intentionally absent until the user invokes Umete on this tab.
    }
    await injectContentScript(tabId);
    const response = await api.tabs.sendMessage(tabId, { type: "UME_PING" }, { frameId: 0 });
    if (!response?.ready) throw new Error(t("errCouldNotStart"));
  }

  async function sendMessage(tabId, message) {
    try {
      await ensureContentScript(tabId);
      return await api.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (error) {
      throw new Error(t("errCommunicate", error.message || "").trim());
    }
  }

  const nativeAppIdentifier = api.runtime.getPlatformInfo().then(({ os }) =>
    os === "ios" ? "com.justin.henry.ume.ios" : "com.justin.henry.ume"
  );

  async function sendNative(message) {
    return api.runtime.sendNativeMessage(await nativeAppIdentifier, message);
  }

  async function appendDebug(event, details = {}) {
    if (!debugLoggingEnabled) return;
    try {
      const stored = await api.storage.local.get(DEBUG_LOG_KEY);
      const previous = stored[DEBUG_LOG_KEY] || "";
      const entry = `[${new Date().toISOString()}] ${event}\n${JSON.stringify(details, null, 2)}\n\n`;
      await api.storage.local.set({ [DEBUG_LOG_KEY]: (previous + entry).slice(-DEBUG_LOG_LIMIT) });
    } catch (_error) {
      // Diagnostics must never interrupt filling.
    }
  }

  async function refreshDebugLog() {
    const stored = await api.storage.local.get(DEBUG_LOG_KEY);
    const existing = stored[DEBUG_LOG_KEY] || "";
    if (!debugLoggingEnabled) {
      // The switch is under AI Provider in the Mac app and AI Matching on iOS.
      const { os = "" } = await api.runtime.getPlatformInfo();
      const suffix = os === "ios" ? "_ios" : "";
      debugLogText.value = existing
        ? `${existing}\n\n${t(`loggingOffWithEntries${suffix}`)}`
        : t(`loggingOff${suffix}`);
      return;
    }
    debugLogText.value = existing || t("noDebugEntries");
  }

  // Addresses are matched locally only. Contacts are split into one sanitized
  // entry per part ("Doctor 2, Cardiologist phone") so the AI can place them
  // without seeing their labels, which are often the person's name.
  function aiSavedEntries(answers) {
    const contacts = answers.filter((answer) => UmeMatcher.answerType(answer) === "contact");
    const totals = {};
    for (const contact of contacts) {
      const category = UmeMatcher.contactCategory(contact);
      totals[category] = (totals[category] || 0) + 1;
    }
    const seen = {};
    return answers.flatMap((answer, index) => {
      const type = UmeMatcher.answerType(answer);
      if (type === "address") return [];
      if (type === "contact") {
        const category = UmeMatcher.contactCategory(answer);
        seen[category] = (seen[category] || 0) + 1;
        const number = totals[category] > 1 ? seen[category] : undefined;
        return UmeMatcher.contactParts(answer, number).map(({ part, entry }) => ({ key: `saved-${index}-${part}`, ...entry }));
      }
      return [{ key: `saved-${index}`, ...answer }];
    });
  }

  function schemaForAI(source, identityKey, identityValue) {
    const result = { [identityKey]: identityValue };
    for (const key of AI_SCHEMA_KEYS) {
      if (source?.[key] !== undefined) result[key] = source[key];
    }
    return result;
  }

  async function activeTab() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error(t("errOpenWebPage"));
    return tab;
  }

  function setBusy(nextBusy, message = t("working")) {
    busy = nextBusy;
    learnButton.disabled = nextBusy;
    fillButton.disabled = nextBusy || cachedAnswers.length === 0;
    activity.hidden = !nextBusy;
    activityLabel.textContent = message;
  }

  function setActivity(message) {
    activityLabel.textContent = message;
  }

  function show(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("error", isError);
  }

  async function loadOnboardingState() {
    const result = await sendNative({ type: "UME_GET_ONBOARDING_STATE" });
    if (!result?.ok) throw new Error(result?.error || t("errSetupStatus"));
    return Boolean(result.complete);
  }

  async function refreshDebugLoggingState() {
    try {
      const result = await sendNative({ type: "UME_GET_DEBUG_LOGGING_STATE" });
      debugLoggingEnabled = Boolean(result?.ok && result.enabled);
    } catch (_error) {
      debugLoggingEnabled = false;
    }
    openDebugLogButton.hidden = false;
  }

  // Opens the Umete app. On the Mac the native handler launches it. iOS gives a Safari
  // extension's native handler no way to open its app (NSExtensionContext.open always
  // fails there), so on iOS the current tab follows a ume:// link: Safari asks to open
  // Umete and leaves the page as it was. The popup then closes, since Safari's question
  // waits behind it. (Following the link from the popup itself leaves an empty tab.)
  async function openUmeteApp(destination, nativeType) {
    const { os = "" } = await api.runtime.getPlatformInfo();
    if (os !== "ios") return sendNative({ type: nativeType });
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error(t(destination === "settings" ? "errSettingsOpen" : "errFinishSetup"));
    await api.tabs.update(tab.id, { url: `ume://${destination}` });
    return { ok: true };
  }

  async function openCompanionApp() {
    openAppButton.disabled = true;
    try {
      const result = await openUmeteApp("onboarding", "UME_OPEN_APP");
      if (!result?.ok) throw new Error(result?.error || t("errFinishSetup"));
      window.close();
    } catch (error) {
      openAppButton.disabled = false;
      getStarted.querySelector("p").textContent = error.message || t("errFinishSetup");
    }
  }

  async function openSettings() {
    openSettingsButton.disabled = true;
    try {
      const result = await openUmeteApp("settings", "UME_OPEN_SETTINGS");
      if (!result?.ok) throw new Error(result?.error || t("errSettingsOpen"));
      window.close();
    } catch (error) {
      openSettingsButton.disabled = false;
      show(error.message || t("errSettingsOpen"), true);
    }
  }

  async function loadNativeAnswers() {
    const result = await sendNative({ type: "UME_GET_ANSWERS" });
    if (!result?.ok) throw new Error(result?.error || t("errAnswersUnavailable"));
    return result.answers || [];
  }

  async function migrateLegacyAnswers(answers) {
    const { answers: legacy = [] } = await api.storage.local.get("answers");
    if (!legacy.length) return answers;
    const merged = UmeMatcher.mergeEntries(answers, legacy);
    const result = await sendNative({ type: "UME_SAVE_ANSWERS", answers: merged });
    if (!result?.ok) throw new Error(result?.error || t("errMigrate"));
    await api.storage.local.remove("answers");
    return merged;
  }

  async function refreshAnswers() {
    cachedAnswers = await migrateLegacyAnswers(await loadNativeAnswers());
    if (!busy) fillButton.disabled = cachedAnswers.length === 0;
    return cachedAnswers;
  }

  async function learn() {
    setBusy(true, t("readingFields"));
    try {
      const tab = await activeTab();
      const result = await sendMessage(tab.id, { type: "UME_COLLECT" });
      const incoming = result?.answers || [];
      if (!incoming.length) throw new Error(t("errNoFields"));
      const merged = UmeMatcher.mergeEntries(cachedAnswers, incoming);
      const saved = await sendNative({ type: "UME_SAVE_ANSWERS", answers: merged });
      if (!saved?.ok) throw new Error(saved?.error || t("errSave"));
      cachedAnswers = merged;
      api.runtime.sendMessage({ type: "UME_ANSWERS_CHANGED" }).catch(() => {});
      api.tabs.sendMessage(tab.id, { type: "UME_REPORT_FIELDS" }, { frameId: 0 }).catch(() => {});
      show(plural("remembered", incoming.length));
    } catch (error) {
      show(error.message || t("errRead"), true);
    } finally {
      setBusy(false);
      await refreshAnswers().catch(() => {});
    }
  }

  async function fill() {
    setBusy(true, t("matching"));
    let locallyFilled = 0;
    try {
      const tab = await activeTab();
      const answers = await refreshAnswers();
      await refreshDebugLoggingState();
      await appendDebug("FILL START", { url: tab.url, tabId: tab.id, savedAnswerCount: answers.length });
      if (!answers.length) throw new Error(t("errRememberFirst"));

      const localResult = await sendMessage(tab.id, { type: "UME_FILL", answers, diagnostics: debugLoggingEnabled });
      await appendDebug("LOCAL FILL RESPONSE", localResult || { response: null });
      locallyFilled = localResult?.filled || 0;
      const schemaResult = await sendMessage(tab.id, { type: "UME_SCHEMAS", answers });
      await appendDebug("SCHEMA RESPONSE", {
        fieldCount: schemaResult?.fields?.length || 0,
        fields: (schemaResult?.fields || []).map(({ options, ...field }) => ({ ...field, optionCount: options?.length || 0 }))
      });
      const fields = schemaResult?.fields || [];

      if (!fields.length) {
        show(locallyFilled
          ? plural("filled", locallyFilled)
          : t("noMatchesFillOnce"));
        return;
      }

      setActivity(t("askingAI"));
      const aiValues = aiSavedEntries(answers);
      const saved = aiValues.map((answer) => schemaForAI(answer, "key", answer.key));
      const sanitizedFields = fields.map((field) => schemaForAI(field, "field", field.field));
      const nativeResult = await sendNative({ type: "UME_MAP_FIELDS", saved, fields: sanitizedFields });
      await appendDebug("NATIVE AI RESPONSE", {
        ok: nativeResult?.ok,
        error: nativeResult?.error || null,
        mappings: nativeResult?.mappings || []
      });
      if (!nativeResult?.ok) throw new Error(nativeResult?.error || t("errAIMapping"));

      setActivity(t("applying"));
      const aiResult = await sendMessage(tab.id, {
        type: "UME_APPLY_MAPPINGS",
        mappings: nativeResult.mappings || [],
        values: aiValues
      });
      await appendDebug("AI APPLY RESPONSE", aiResult || { response: null });
      const aiFilled = aiResult?.filled || 0;
      const total = locallyFilled + aiFilled;
      await appendDebug("FILL COMPLETE", { locallyFilled, aiFilled, total });
      show(total
        ? (aiFilled ? filledWithAI(total, aiFilled) : plural("filled", total))
        : t("noMatches"));
    } catch (error) {
      const message = error.message || t("errFill");
      await appendDebug("FILL ERROR", { message, stack: error.stack || null, locallyFilled });
      show(locallyFilled
        ? plural("filledLocallyAIUnavailable", locallyFilled, message)
        : message, true);
    } finally {
      setBusy(false);
      await refreshAnswers().catch(() => {});
    }
  }

  // Optional toolbar badge. Turning it on asks Safari for access to all websites,
  // then registers detect.js so pages are checked for forms. Off by default.
  const FORM_BADGE_KEY = "ume-form-badge";
  const DETECT_SCRIPT_ID = "ume-detect";
  const formBadgeOption = document.getElementById("form-badge-option");
  const formBadgeToggle = document.getElementById("form-badge");
  const supportsFormBadge = Boolean(api.scripting?.registerContentScripts && api.permissions?.request && api.action?.setBadgeText);

  async function loadFormBadgeState() {
    if (!supportsFormBadge) return;
    const stored = await api.storage.local.get(FORM_BADGE_KEY);
    formBadgeToggle.checked = Boolean(stored[FORM_BADGE_KEY]);
    formBadgeOption.hidden = false;
  }

  async function enableFormBadge(permissionRequest) {
    const granted = await permissionRequest.catch(() => false);
    if (!granted) {
      formBadgeToggle.checked = false;
      show(t("badgeNeedsAccess"), true);
      return;
    }
    try {
      await api.scripting.registerContentScripts([{
        id: DETECT_SCRIPT_ID,
        js: ["detect.js"],
        matches: ["<all_urls>"],
        runAt: "document_idle",
        persistAcrossSessions: true
      }]);
    } catch (error) {
      if (!/already|exist|duplicate/i.test(error.message || "")) throw error;
    }
    await api.storage.local.set({ [FORM_BADGE_KEY]: true });
    const tab = await activeTab().catch(() => null);
    if (tab) await api.tabs.sendMessage(tab.id, { type: "UME_REPORT_FIELDS" }, { frameId: 0 }).catch(() => {});
    show(t("badgeOn"));
  }

  async function disableFormBadge() {
    await api.scripting.unregisterContentScripts({ ids: [DETECT_SCRIPT_ID] }).catch(() => {});
    await api.storage.local.set({ [FORM_BADGE_KEY]: false });
    show(t("badgeOff"));
  }

  formBadgeToggle.addEventListener("change", () => {
    // permissions.request must start synchronously inside the user gesture.
    const request = formBadgeToggle.checked ? api.permissions.request({ origins: ["<all_urls>"] }) : null;
    const change = request ? enableFormBadge(request) : disableFormBadge();
    change.catch((error) => {
      formBadgeToggle.checked = !formBadgeToggle.checked;
      show(error.message || t("errBadge"), true);
    });
  });

  learnButton.addEventListener("click", learn);
  fillButton.addEventListener("click", fill);
  openAppButton.addEventListener("click", openCompanionApp);
  openSettingsButton.addEventListener("click", openSettings);
  openDebugLogButton.addEventListener("click", async () => {
    await refreshDebugLog();
    debugLogPanel.hidden = false;
    debugLogText.focus();
  });
  closeDebugLogButton.addEventListener("click", () => { debugLogPanel.hidden = true; });
  deleteDebugLogButton.addEventListener("click", async () => {
    await api.storage.local.remove(DEBUG_LOG_KEY);
    await refreshDebugLog();
  });
  copyDebugLogButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(debugLogText.value);
    copyDebugLogButton.textContent = t("copied");
    setTimeout(() => { copyDebugLogButton.textContent = t("copy"); }, 1200);
  });
  emailDebugLogButton.addEventListener("click", async () => {
    emailDebugLogButton.disabled = true;
    try {
      const { os = "" } = await api.runtime.getPlatformInfo();
      const appInfo = await sendNative({ type: "UME_GET_APP_INFO" }).catch(() => null);
      window.location.href = UmeDebugEmail.buildDebugEmail(debugLogText.value, UmeDebugEmail.reportSource(appInfo, os));
    } catch (error) {
      show(error.message || t("errEmail"), true);
      emailDebugLogButton.disabled = false;
    }
  });

  loadFormBadgeState().catch(() => {});
  Promise.all([loadOnboardingState(), refreshDebugLoggingState()])
    .then(([complete]) => {
      getStarted.hidden = complete;
      readyContent.hidden = !complete;
      if (complete) return refreshAnswers();
      return undefined;
    })
    .catch((error) => {
      getStarted.hidden = false;
      readyContent.hidden = true;
      getStarted.querySelector("p").textContent = error.message || "Open the Umete app to finish setup.";
    });
})();
