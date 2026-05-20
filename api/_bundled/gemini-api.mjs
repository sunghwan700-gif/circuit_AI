// server/gemini-chat-core.mjs
async function prepareGeminiChatRequest(body, env) {
  const {
    messages,
    contextDescription,
    images,
    skipRefine: skipRefineBody,
    practiceContext,
    chatGuidance,
    hasImages: hasImagesBody,
    preferFlash: preferFlashBody,
    aiTask: aiTaskBody
  } = body || {};
  const key = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.OPENAI_API_KEY || "").trim();
  if (!key) {
    return {
      ok: false,
      statusCode: 500,
      body: JSON.stringify({
        error: {
          message: "\uC11C\uBC84\uC5D0 GEMINI_API_KEY(\uB610\uB294 GOOGLE_API_KEY)\uAC00 \uC124\uC815\uB418\uC5B4 \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uB85C\uCEEC\uC740 .env, Vercel\uC740 Project \u2192 Environment Variables\uC5D0 \uCD94\uAC00\uD55C \uB4A4 \uC7AC\uBC30\uD3EC\uD558\uC138\uC694."
        }
      })
    };
  }
  const normalizeModel = (m) => String(m || "").replace(/^models\//, "").trim();
  const isRetiredModel = (name) => {
    const n = normalizeModel(name).toLowerCase();
    if (!n) return true;
    if (/flash-lite|gemini-1\.0|gemini-pro(?!-)/i.test(n)) return true;
    if (n === "gemini-2.0-flash-lite" || n === "gemini-1.5-flash-8b" || n === "gemini-1.5-flash-8b-latest") {
      return true;
    }
    return false;
  };
  const dedupeModels2 = (list) => {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const raw of list) {
      const m = normalizeModel(raw);
      if (!m || isRetiredModel(m) || seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
    return out.length ? out : [defaultModel];
  };
  const isServerlessDeploy = String(env.VERCEL || "") === "1";
  const serverlessCompact = isServerlessDeploy && String(env.GEMINI_SERVERLESS_COMPACT ?? "0").trim() === "1";
  const ctx = String(contextDescription || "");
  const aiTask = String(aiTaskBody || "").trim().toLowerCase();
  const isTeacherDraftJob = aiTask === "teacher-draft" || /교사용 개별 피드백 초안/i.test(ctx);
  const isReportJsonJob = aiTask === "report-json" || /최종 보고서|SWOT|종합 피드백/i.test(ctx) && !isTeacherDraftJob;
  const isReportJob = isReportJsonJob || isTeacherDraftJob;
  const isChatJob = !isReportJob;
  const explicitModel = normalizeModel(
    env.GEMINI_MODEL || env.GOOGLE_MODEL || ""
  );
  const chatModelEnv = normalizeModel(env.GEMINI_CHAT_MODEL || "");
  const defaultModel = "gemini-2.5-flash";
  const flashPrimary = "gemini-2.5-flash";
  let primaryModel;
  if (preferFlashBody === true) {
    primaryModel = flashPrimary;
  } else if (isChatJob) {
    primaryModel = chatModelEnv || explicitModel || defaultModel;
  } else if (isReportJob) {
    primaryModel = explicitModel || chatModelEnv || defaultModel;
  } else {
    primaryModel = explicitModel || defaultModel;
  }
  const useProPrimary = /pro/i.test(primaryModel);
  const proOnlyFlag = String(env.GEMINI_PRO_ONLY ?? "").trim().toLowerCase();
  const proOnly = proOnlyFlag === "1" || proOnlyFlag === "true" || proOnlyFlag !== "0" && proOnlyFlag !== "false" && useProPrimary && preferFlashBody !== true;
  const chatFallbackDefault = proOnly ? "" : "gemini-2.5-flash,gemini-2.0-flash";
  const fallbackModels = String(
    env.GEMINI_FALLBACK_MODELS ?? chatFallbackDefault
  ).split(",").map((s) => normalizeModel(s)).filter(Boolean).filter((m) => !proOnly || /pro/i.test(m));
  const isBgJob = String(env.GEMINI_BG_JOB || "").trim() === "1";
  let modelCandidates = dedupeModels2(
    proOnly ? [primaryModel] : [primaryModel, ...fallbackModels]
  );
  if (proOnly) {
    modelCandidates = modelCandidates.filter((m) => /pro/i.test(m));
    if (!modelCandidates.length) {
      modelCandidates = dedupeModels2([
        chatModelEnv || explicitModel || "gemini-2.5-pro"
      ]).filter((m) => /pro/i.test(m));
    }
  } else if (useProPrimary || isBgJob) {
    const proFirst = modelCandidates.filter((m) => /pro/i.test(m));
    const rest = modelCandidates.filter((m) => !/pro/i.test(m));
    modelCandidates = [...proFirst, ...rest];
  } else if ((isChatJob || isReportJob) && serverlessCompact) {
    const flashFirst = modelCandidates.filter((m) => /flash/i.test(m));
    const rest = modelCandidates.filter((m) => !/flash/i.test(m));
    modelCandidates = [...flashFirst, ...rest];
  }
  const syncProTight = isServerlessDeploy && useProPrimary && !isBgJob && preferFlashBody !== true && String(env.GEMINI_SYNC_PRO_TIGHT ?? "0").trim() === "1";
  const earlyMsgList = (Array.isArray(messages) ? messages : []).filter((m) => {
    const t = String(m?.content || "").trim();
    if (m?.role === "user" && /^다음은 전기 실습/.test(t)) return false;
    return true;
  });
  const earlyLastQ = (() => {
    for (let i = earlyMsgList.length - 1; i >= 0; i--) {
      if (earlyMsgList[i]?.role === "user") {
        const t = String(earlyMsgList[i].content || "").trim();
        if (t && !/^다음은 전기 실습/.test(t)) return t;
      }
    }
    return "";
  })();
  const wantsDetail = isChatJob && /종합|전체|접점|단자|번호|표|목록|EOCR|MC|PB|릴레이|회로도.*작성|기입|정리|작성해/i.test(
    `${earlyLastQ}
${contextDescription}`
  );
  const tokensParsed = Number(String(env.GEMINI_MAX_OUTPUT_TOKENS || "").trim());
  const defaultMaxTokens = isReportJsonJob ? useProPrimary ? 4096 : 3072 : isTeacherDraftJob ? useProPrimary ? 1536 : 1280 : useProPrimary ? syncProTight ? isChatJob ? 3072 : 2560 : isChatJob ? wantsDetail ? 4096 : 3072 : 2560 : serverlessCompact ? 3584 : 6144;
  const maxOutputTokens = Number.isFinite(tokensParsed) && tokensParsed >= 512 && tokensParsed <= 8192 ? Math.floor(tokensParsed) : defaultMaxTokens;
  const modelCandidatesRun = proOnly ? modelCandidates.slice(0, 1) : serverlessCompact && !isBgJob ? modelCandidates.slice(0, useProPrimary ? 3 : 2) : modelCandidates;
  const maxContinues = syncProTight && isChatJob ? 0 : isReportJsonJob || isTeacherDraftJob ? isServerlessDeploy ? 3 : 4 : isBgJob && isChatJob ? 2 : isChatJob ? isServerlessDeploy ? 2 : useProPrimary ? 4 : 2 : useProPrimary ? syncProTight ? 0 : 3 : serverlessCompact ? 2 : 4;
  const retryDelaysMs = isBgJob ? [700, 1500, 3e3, 5e3, 8e3] : syncProTight ? [300, 700, 1200] : serverlessCompact ? [400, 900, 1800] : [250, 750, 1500, 3e3];
  const fetchTimeoutParsed = Number(String(env.GEMINI_FETCH_TIMEOUT_MS || "").trim());
  const geminiFetchTimeoutMs = Number.isFinite(fetchTimeoutParsed) && fetchTimeoutParsed >= 5e3 ? Math.floor(fetchTimeoutParsed) : isServerlessDeploy ? isReportJsonJob || isTeacherDraftJob ? 57e3 : syncProTight ? 23e3 : 52e3 : 12e4;
  const preferOneshot = isServerlessDeploy && !isBgJob && String(env.GEMINI_STREAM_CHAT ?? "0").trim() !== "1";
  const imageList = Array.isArray(images) ? images : [];
  const hasImages = imageList.length > 0 || hasImagesBody === true || hasImagesBody === "true";
  const getLastUserQuestion = (list) => {
    const arr = Array.isArray(list) ? list : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]?.role === "user") {
        const t = String(arr[i].content || "").trim();
        if (t && !/^다음은 전기 실습/.test(t)) return t;
      }
    }
    return "";
  };
  if (serverlessCompact && imageList.length > 4) {
    return {
      ok: false,
      statusCode: 413,
      body: JSON.stringify({
        error: {
          message: "\uD55C \uBC88\uC5D0 \uBCF4\uB0BC \uC774\uBBF8\uC9C0\uAC00 \uB108\uBB34 \uB9CE\uC2B5\uB2C8\uB2E4. \uD68C\uB85C\uB3C4 1\uC7A5\uACFC \uC2E4\uC2B5 \uC0AC\uC9C4 2~3\uC7A5 \uC774\uD558\uB85C \uC904\uC5EC \uB2E4\uC2DC \uC9C8\uBB38\uD574 \uC8FC\uC138\uC694."
        }
      })
    };
  }
  let approxImageBytes = 0;
  for (const img of imageList) {
    const m = /^data:[^;]+;base64,(.+)$/i.exec(String(img?.dataUrl || ""));
    if (m) approxImageBytes += Math.ceil(m[1].length * 3 / 4);
  }
  const maxImageBytes = syncProTight ? 24e5 : serverlessCompact ? 32e5 : 8e6;
  if (approxImageBytes > maxImageBytes) {
    return {
      ok: false,
      statusCode: 413,
      body: JSON.stringify({
        error: {
          message: "\uC774\uBBF8\uC9C0 \uC6A9\uB7C9\uC774 \uCEE4\uC11C \uC11C\uBC84 \uD55C\uB3C4\uB97C \uB118\uC5C8\uC2B5\uB2C8\uB2E4. \uD68C\uB85C\uB3C4\uB9CC \uC62C\uB9B0 \uB4A4 \uB2E4\uC2DC \uC9C8\uBB38\uD558\uAC70\uB098, \uC0AC\uC9C4 \uD574\uC0C1\uB3C4\uB97C \uB0AE\uCDB0 \uC8FC\uC138\uC694."
        }
      })
    };
  }
  const chatExtra = isChatJob ? String(chatGuidance || "").trim() : "";
  const practiceExtra = String(practiceContext || "").trim();
  const systemContent = `\uB2F9\uC2E0\uC740 \uC804\uAE30 \uC2E4\uC2B5(\uD68C\uB85C\xB7\uC2B9\uAC15\uAE30\xB7\uCCA0\uB3C4\uC804\uAE30\uC2E0\uD638 \uB4F1) \uC2E4\uC2B5\uC77C\uC9C0\uB97C \uB3D5\uB294 \uC870\uAD50\uC785\uB2C8\uB2E4. \uD56D\uC0C1 \uD55C\uAD6D\uC5B4\uB85C \uB2F5\uD569\uB2C8\uB2E4.

\uBAA9\uD45C: \uD559\uC2B5\uC790\uAC00 \uC2E4\uC2B5 \uC911 \uC9C8\uBB38\uD558\uACE0, \uD68C\uB85C\uB3C4\xB7\uC2E4\uC2B5 \uC0AC\uC9C4\uC744 \uADFC\uAC70\uB85C \uC815\uD655\uD55C \uD53C\uB4DC\uBC31\uC744 \uBC1B\uB3C4\uB85D \uB3D5\uC2B5\uB2C8\uB2E4.

${isReportJsonJob ? `\u3010\uBCF4\uACE0\uC11C JSON \uC791\uC5C5\u3011
- \uC0AC\uC6A9\uC790 \uC9C0\uC2DC\uB300\uB85C **\uC720\uD6A8\uD55C JSON\uB9CC** \uCD9C\uB825\uD569\uB2C8\uB2E4(\uC124\uBA85\xB7\uB9C8\uD06C\uB2E4\uC6B4\xB7\`\`\` \uC5C6\uC74C).
- \uD0A4 summary, swot {s,w,o,t} \uB97C \uCC44\uC6C1\uB2C8\uB2E4.
- Circuit Chatbot \uB300\uD654\xB7\uCCA8\uBD80 \uC774\uBBF8\uC9C0\xB7\uC790\uAE30\uD3C9\uAC00\xB7\uD559\uC2B5\uC790 SWOT \uCD08\uC548\uC744 **\uD568\uAED8 \uC77D\uACE0** \uC77C\uAD00\uB41C \uC885\uD569 \uD53C\uB4DC\uBC31\uC744 \uB9CC\uB4ED\uB2C8\uB2E4. **\uB300\uD654\uAC00 \uC8FC\uC694 \uADFC\uAC70**\uC785\uB2C8\uB2E4. \uB300\uD654\uB97C \uBB34\uC2DC\uD55C \uC77C\uBC18\uB860\xB7\uB3D9\uBB38\uC11C\uB2F5 \uAE08\uC9C0.
- \uC2E4\uC2B5 \uC0AC\uC9C4\uC774 \uC5C6\uC73C\uBA74 \uB300\uD654\xB7\uC790\uAE30\uD3C9\uAC00\uB9CC\uC73C\uB85C \uC791\uC131\uD558\uACE0, \uC0AC\uC9C4 \uC5C6\uC774 \uBC30\uC120\xB7\uC2E4\uBB3C\uC744 \uB2E8\uC815\uD558\uC9C0 \uB9C8\uC138\uC694.
- \uC790\uB8CC\uC5D0 \uC5C6\uB294 \uB2E8\uC790\xB7\uBC30\uC120\xB7\uACE0\uC7A5 \uB2E8\uC815 \uAE08\uC9C0.` : isTeacherDraftJob ? `\u3010\uAD50\uC0AC \uD53C\uB4DC\uBC31 \uCD08\uC548\u3011
- \uC81C\uCD9C\uC758 Circuit Chatbot \uB300\uD654\xB7AI \uC885\uD569 \uD53C\uB4DC\uBC31\xB7SWOT\xB7\uC790\uAE30\uD3C9\uAC00\xB7\uC0AC\uC9C4\uC744 \uBAA8\uB450 \uC77D\uACE0 \uD53C\uB4DC\uBC31 \uCD08\uC548 \uC791\uC131. \uB300\uD654\xB7\uC885\uD569 \uD53C\uB4DC\uBC31\uC744 \uBC18\uB4DC\uC2DC \uBC18\uC601.
- **\uD55C \uBC88\uC5D0 \uC644\uACB0**: ## \uCD1D\uD3C9(2~3\uBB38\uC7A5) \u2192 ## \uC798\uD55C \uC810(\uBD88\uB9BF 2~3) \u2192 ## \uBCF4\uC644\xB7\uB2E4\uC74C \uC2E4\uC2B5(\uBD88\uB9BF 2~3) \u2192 ## \uC548\uC804\xB7\uD655\uC778(\uD574\uB2F9 \uC2DC 1~2\uBB38\uC7A5). **400~650\uC790**.
- \uC911\uC694 \uB0B4\uC6A9\uC740 \uBE60\uB728\uB9AC\uC9C0 \uB9D0\uB418 \uC7A5\uD669\uD55C \uBC18\uBCF5\uC740 \uAE08\uC9C0. \uC81C\uCD9C\uC5D0 \uC5C6\uB294 \uC0AC\uC2E4\xB7\uB2E8\uC790 \uBC88\uD638 \uAE08\uC9C0.` : isChatJob ? wantsDetail ? `\uCC44\uD305(\uC0C1\uC138\xB7\uBAA9\uB85D\xB7\uC811\uC810):
- \uC9C8\uBB38\uC5D0 \uC9C1\uC811 \uB2F5\uD568. **\uD55C \uBC88\uC5D0 \uB05D\uAE4C\uC9C0**: ## \uC694\uC57D \u2192 ## \uD575\uC2EC(\uBD88\uB9BF 4~6, \uAC01 1\uBB38\uC7A5 \uC644\uACB0) \u2192 ## \uD560 \uC77C(2~3). **500~750\uC790**.
- \uC811\uC810\xB7\uB2E8\uC790\uB294 \uB3C4\uBA74 \uD45C\uAE30\uB9CC.` : `\uCC44\uD305 \uB2F5\uBCC0(\uADE0\uD615\uD615):
- \uB9C8\uC9C0\uB9C9 \uC9C8\uBB38\uC5D0 **\uC9C1\uC811** \uB2F5\uD568. \uB3D9\uBB38\uC11C\uB2F5\xB7\uAC15\uC758 \uAE08\uC9C0.
- **\uD55C \uBC88\uC5D0 \uC138 \uC139\uC158 \uBAA8\uB450 \uC644\uACB0**: ## \uC694\uC57D(1~2\uBB38\uC7A5) \u2192 ## \uD575\uC2EC(\uBD88\uB9BF 3~4, \uAD6C\uCCB4\uC801) \u2192 ## \uD560 \uC77C(\uBD88\uB9BF 2~3). \uC548\uC804 \uC774\uC288\uB294 \uB9E8 \uC704 ## \uC548\uC804(1~2\uBB38\uC7A5).
- \uBD84\uB7C9 **350~550\uC790**. \uB108\uBB34 \uC9E7\uAC8C \uC0DD\uB7B5\uD558\uC9C0 \uB9D0\uACE0, \uBD88\uD544\uC694\uD55C \uC7A5\uBB38\xB7\uBC18\uBCF5\uC740 \uAE08\uC9C0.
- \uBAA8\uB4E0 \uBD88\uB9BF\uC744 \uBB38\uC7A5\uC73C\uB85C \uB05D\uB0B8 \uB4A4 \uC885\uB8CC\uD558\uC138\uC694.` : ""}

\uC815\uD655\uC131(\uD658\uAC01 \uBC29\uC9C0):
- \uD655\uC778\uD55C \uC0AC\uC2E4\uB9CC \uC501\uB2C8\uB2E4. \uBD88\uD655\uC2E4\uD558\uBA74 "\uB3C4\uBA74\xB7\uC2E4\uBB3C \uD655\uC778 \uD544\uC694" \uD55C \uC904.
- \uC811\uC810\xB7\uCF54\uC77C\xB7\uB2E8\uC790 \uBC88\uD638(A1-A2, 95-96, 6-12 \uB4F1)\uB294 **\uB3C4\uBA74\xB7\uC0AC\uC9C4\uC5D0 \uBCF4\uC774\uB294 \uD45C\uAE30\uB9CC**. \uC548 \uBCF4\uC774\uBA74 \uCD94\uCE21\xB7\uC77C\uBC18\uB860 \uBC88\uD638\uB97C \uC4F0\uC9C0 \uB9C8\uC138\uC694.
- EOCR\xB7MC\xB7T\xB7PB\uB294 \uAE30\uAE30\xB7\uC81C\uC870\uC0AC\uB9C8\uB2E4 \uD45C\uAE30\uAC00 \uB2E4\uB985\uB2C8\uB2E4. \uB2E4\uB978 \uAE30\uAE30 \uBC88\uD638\uB97C \uC11E\uC5B4 \uC4F0\uC9C0 \uB9C8\uC138\uC694.
- \uCD94\uCE21\xB7\uAC00\uC0C1 \uBC30\uC120 \uAE08\uC9C0. \uADFC\uAC70\uB294 \uAF2D \uD544\uC694\uD55C \uC8FC\uC7A5\uC5D0\uB9CC (\uADFC\uAC70: \u2026) 1\uD68C.
- \uD655\uC778 \uC9C8\uBB38\uC740 \uCD5C\uB300 1\uAC1C(\uC815\uB9D0 \uD544\uC694\uD560 \uB54C\uB9CC).

\uD559\uC2B5\uC790 \uC218\uC900: \uC804\uAE30 \uCD08\uBCF4\uC790\uB3C4 \uC774\uD574\uD560 \uC218 \uC788\uAC8C, \uC804\uBB38 \uC6A9\uC5B4\uB294 \uAD04\uD638\uB85C \uC26C\uC6B4 \uB73B\uC744 \uBD99\uC785\uB2C8\uB2E4.
\uC548\uC804: \uAC10\uC804\xB7\uB2E8\uB77D\xB7\uACFC\uC5F4 \uAC00\uB2A5\uC131\uC774 \uC788\uC73C\uBA74 \uB9E8 \uC55E\uC5D0 \uC804\uC6D0 \uCC28\uB2E8\xB7LOCKOUT\uC744 \uC548\uB0B4\uD569\uB2C8\uB2E4.

${isReportJsonJob ? hasImages ? `\uCCA8\uBD80 \uC774\uBBF8\uC9C0\xB7\uB300\uD654\xB7\uC790\uAE30\uD3C9\uAC00\uB97C \uAD50\uCC28 \uD655\uC778\uD574 JSON\uC758 summary\xB7swot\uB97C \uCC44\uC6B0\uC138\uC694.` : `\uC774\uBBF8\uC9C0 \uC5C6\uC74C: \uB300\uD654\xB7\uC790\uAE30\uD3C9\uAC00\xB7SWOT \uCD08\uC548\uB9CC\uC73C\uB85C JSON\uC744 \uCC44\uC6B0\uC138\uC694.` : isTeacherDraftJob ? hasImages ? `\uC81C\uCD9C \uD68C\uB85C\uB3C4\xB7\uACB0\uACFC \uC0AC\uC9C4\uC744 \uBCF4\uACE0 \uD53C\uB4DC\uBC31 \uCD08\uC548\uC5D0 \uBC18\uC601\uD558\uC138\uC694.` : `\uC0AC\uC9C4 \uC5C6\uC74C: \uD14D\uC2A4\uD2B8 \uC81C\uCD9C(SWOT\xB7\uC790\uAE30\uD3C9\uAC00)\uB9CC \uADFC\uAC70\uB85C \uCD08\uC548\uC744 \uC791\uC131\uD558\uC138\uC694.` : hasImages && isChatJob ? `\uCCA8\uBD80 \uC774\uBBF8\uC9C0(\uD68C\uB85C\uB3C4\xB7\uC2E4\uC2B5 \uC0AC\uC9C4)\uB294 \uB9C8\uC9C0\uB9C9 \uD559\uC0DD \uC9C8\uBB38\uC5D0 \uB2F5\uD560 \uB54C \uCC38\uACE0\uD558\uC138\uC694.` : !hasImages && isChatJob ? `\uBD84\uC11D\uC6A9 \uC774\uBBF8\uC9C0 \uC5C6\uC74C: \uB2E8\uC790\xB7\uBC30\uC120 \uB2E8\uC815 \uAE08\uC9C0. \uD544\uC694\uD55C \uC0AC\uC9C4 \uC548\uB0B4\uC640 \uC77C\uBC18 \uC548\uC804\uB9CC \uAC1C\uC694\uD615\uC73C\uB85C \uB2F5\uD558\uC138\uC694.` : hasImages && !isChatJob ? `\uC774\uBC88 \uC694\uCCAD\uC5D0 \uD68C\uB85C\uB3C4\xB7\uC2E4\uC2B5 \uC0AC\uC9C4\uC774 \uD3EC\uD568\uB420 \uC218 \uC788\uC2B5\uB2C8\uB2E4.` : `\uBD84\uC11D\uC6A9 \uC774\uBBF8\uC9C0\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uCD94\uCE21 \uC9C4\uB2E8\xB7\uB2E8\uC790 \uBC88\uD638\uB97C \uC4F0\uC9C0 \uB9C8\uC138\uC694.`}

\uD604\uC7AC \uC2E4\uC2B5 \uB2E8\uACC4: ${contextDescription || ""}
${chatExtra ? `
${chatExtra}` : ""}
${practiceExtra ? `
${practiceExtra}` : ""}`;
  try {
    const trimText = (s, max = 2400) => {
      const t = String(s ?? "");
      return t.length <= max ? t : `${t.slice(0, max)}
\u2026(\uC774\uD558 \uC0DD\uB7B5)`;
    };
    let msgList = Array.isArray(messages) ? messages : [];
    msgList = msgList.filter((m) => {
      const t = String(m?.content || "").trim();
      if (m?.role === "user" && /^다음은 전기 실습/.test(t)) return false;
      return true;
    });
    if (serverlessCompact && msgList.length > 12) {
      msgList = msgList.slice(-12);
    }
    const lastUserQuestion = getLastUserQuestion(msgList);
    const contents = msgList.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: trimText(m.content, serverlessCompact ? 2800 : 4800) }]
    }));
    if (imageList.length) {
      const toInlinePart = (img) => {
        const dataUrl = String(img?.dataUrl || "");
        const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
        if (!m) return null;
        const mimeType = m[1] || "image/jpeg";
        const data = m[2] || "";
        if (!data) return null;
        return { inlineData: { mimeType, data } };
      };
      let lastUserIdx = -1;
      for (let i = contents.length - 1; i >= 0; i--) {
        if (contents[i]?.role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx < 0) {
        contents.push({
          role: "user",
          parts: [{ text: "" }]
        });
        lastUserIdx = contents.length - 1;
      }
      const attachNote = imageList.map((img) => String(img?.label || "")).filter(Boolean).join(", ");
      const qBlock = isReportJsonJob || isTeacherDraftJob ? `\u3010\uC791\uC5C5 \uC9C0\uC2DC\u3011
${lastUserQuestion || "(\uC9C0\uC2DC\uBB38 \uCC38\uACE0)"}` : lastUserQuestion ? `\u3010\uC774\uBC88 \uD559\uC0DD \uC9C8\uBB38 \u2014 \uC774\uAC83\uC5D0\uB9CC \uB2F5\uD560 \uAC83\u3011
${lastUserQuestion}` : "\u3010\uC774\uBC88 \uD559\uC0DD \uC9C8\uBB38\u3011 (\uD14D\uC2A4\uD2B8 \uC5C6\uC74C \u2014 \uC774\uBBF8\uC9C0 \uAE30\uC900\uC73C\uB85C \uC548\uB0B4)";
      const lengthHint = isReportJsonJob ? "JSON\uB9CC. summary 3~5\uBB38\uC7A5, swot \uAC01 1~2\uBB38\uC7A5. \uD55C \uBC88\uC5D0 \uC644\uC804\uD55C JSON." : isTeacherDraftJob ? "\uD53C\uB4DC\uBC31 \uCD08\uC548: ## \uCD1D\uD3C9\xB7\uC798\uD55C \uC810\xB7\uBCF4\uC644\xB7\uC548\uC804 \uBAA8\uB450 \uC791\uC131, 400~650\uC790." : wantsDetail ? "## \uC694\uC57D\xB7\uD575\uC2EC\xB7\uD560 \uC77C\uC744 \uD55C \uBC88\uC5D0 \uC644\uACB0, 500~750\uC790." : "## \uC694\uC57D\xB7\uD575\uC2EC\xB7\uD560 \uC77C\uC744 \uD55C \uBC88\uC5D0 \uC644\uACB0, 350~550\uC790. \uC911\uC694 \uB0B4\uC6A9 \uD3EC\uD568.";
      contents[lastUserIdx].parts.unshift({
        text: `${qBlock}

\u3010\uCC38\uACE0 \uC774\uBBF8\uC9C0\u3011${attachNote || "\uCCA8\uBD80\uB428"}
${lengthHint}`
      });
      for (const img of imageList) {
        const part = toInlinePart(img);
        if (part) contents[lastUserIdx].parts.push(part);
      }
    }
    return {
      ok: true,
      key,
      systemContent,
      contents,
      modelCandidatesRun,
      maxOutputTokens,
      isChatJob,
      geminiFetchTimeoutMs,
      temperature: isChatJob ? 0.12 : 0.12,
      topP: isChatJob ? 0.85 : 0.9,
      serverlessCompact,
      syncProTight,
      primaryModel,
      maxContinues,
      retryDelaysMs,
      skipRefineBody,
      hasImages,
      contextDescription,
      imageList,
      lastUserQuestion,
      wantsDetail,
      isReportJsonJob,
      isTeacherDraftJob,
      proOnly,
      preferOneshot,
      isServerlessDeploy
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      statusCode: 500,
      body: JSON.stringify({
        error: {
          message: /abort|timeout|timed out/i.test(msg) ? "\uC11C\uBC84 \uC751\uB2F5 \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694." : msg
        }
      })
    };
  }
}
async function runGeminiChatProxy(body, env) {
  const prep = await prepareGeminiChatRequest(body, env);
  if (!prep.ok) {
    return { ok: false, statusCode: prep.statusCode, body: prep.body };
  }
  const {
    key,
    systemContent,
    contents,
    modelCandidatesRun,
    maxOutputTokens,
    isChatJob,
    geminiFetchTimeoutMs,
    serverlessCompact,
    syncProTight,
    primaryModel,
    maxContinues,
    retryDelaysMs,
    skipRefineBody,
    hasImages,
    contextDescription,
    imageList,
    lastUserQuestion
  } = prep;
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const backoffMs = retryDelaysMs;
    let lastStatus = 500;
    let lastMessage = "\uC694\uCCAD\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.";
    let rawText = "";
    let usedModel = "";
    let out = "";
    let finishReason = "";
    const stripInlineImagesFromContents2 = (contentsArr) => contentsArr.map((turn) => ({
      role: turn.role,
      parts: (turn.parts || []).filter((p) => !p.inlineData)
    }));
    const extractTextAndFinish = (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return { text: "", finishReason: "", blocked: false };
      }
      const blockReason = String(
        data.promptFeedback?.blockReason || data.candidates?.[0]?.finishMessage || ""
      ).trim();
      const parts = data.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.filter((p) => p && p.thought !== true).map((p) => typeof p?.text === "string" ? p.text : "").join("").trim() : "";
      const finishReason2 = String(data.candidates?.[0]?.finishReason || "").trim();
      const blocked = !!blockReason || finishReason2 === "SAFETY" || finishReason2 === "RECITATION" || !text && !data.candidates?.length;
      return { text, finishReason: finishReason2, blocked, blockReason };
    };
    const blockedMessage = (blockReason, finishReason2) => {
      if (/SAFETY|RECITATION|BLOCK/i.test(`${blockReason} ${finishReason2}`)) {
        return "\uC548\uC804\xB7\uC815\uCC45 \uD544\uD130\uB85C \uC774 \uB2F5\uBCC0\uC744 \uC0DD\uC131\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC9C8\uBB38\uC744 \uB2E4\uB974\uAC8C \uD45C\uD604\uD558\uAC70\uB098, \uD68C\uB85C\uB3C4\uB9CC \uCCA8\uBD80\uD574 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.";
      }
      return "\uBAA8\uB378\uC774 \uB2F5\uBCC0\uC744 \uC0DD\uC131\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.";
    };
    const callGemini = async (model, contentsToSend) => {
      const fetchInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          systemInstruction: {
            role: "system",
            parts: [{ text: systemContent }]
          },
          contents: contentsToSend,
          generationConfig: {
            temperature: isChatJob ? 0.12 : 0.12,
            topP: isChatJob ? 0.85 : 0.9,
            maxOutputTokens
          }
        }),
        signal: AbortSignal.timeout(geminiFetchTimeoutMs)
      };
      return fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model
        )}:generateContent`,
        fetchInit
      );
    };
    const tryParseResponse = (raw, modelName) => {
      const parsed = extractTextAndFinish(raw);
      if (parsed.blocked && !parsed.text) {
        return {
          ok: false,
          blocked: true,
          message: blockedMessage(parsed.blockReason, parsed.finishReason)
        };
      }
      if (parsed.text.trim()) {
        return {
          ok: true,
          text: parsed.text,
          finishReason: parsed.finishReason,
          model: modelName
        };
      }
      return { ok: false, blocked: false, empty: true };
    };
    modelLoop: for (const model of modelCandidatesRun) {
      for (let attempt = 0; attempt < backoffMs.length + 1; attempt++) {
        const r = await callGemini(model, contents);
        rawText = await r.text();
        if (r.ok) {
          const hit = tryParseResponse(rawText, model);
          if (hit.ok && hit.text) {
            out = hit.text;
            finishReason = hit.finishReason || "";
            usedModel = hit.model || model;
            lastStatus = 200;
            break modelLoop;
          }
          if (hit.blocked) {
            return {
              ok: false,
              statusCode: 422,
              body: JSON.stringify({ error: { message: hit.message } })
            };
          }
          lastStatus = 502;
          lastMessage = "empty_response";
          if (attempt < backoffMs.length) {
            await sleep(backoffMs[attempt]);
            continue;
          }
          break;
        }
        lastStatus = r.status || 500;
        let msg = rawText;
        try {
          const j = JSON.parse(rawText);
          msg = j.error?.message || j.error || rawText;
        } catch {
        }
        lastMessage = String(msg || rawText || "\uC694\uCCAD\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
        if (/<TITLE>\s*Inactivity Timeout\s*<\/TITLE>/i.test(lastMessage) || /Inactivity Timeout/i.test(lastMessage)) {
          lastMessage = "\uC11C\uBC84 \uC751\uB2F5 \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694. (\uC774\uBBF8\uC9C0\uAC00 \uB9CE\uAC70\uB098 \uD06C\uBA74 \uD55C \uC7A5\uB9CC \uC62C\uB9B0 \uB4A4 \uC9C8\uBB38\uD574 \uBCF4\uC138\uC694.)";
          break;
        }
        const modelUnavailable = lastStatus === 404 || /no longer available|not found|is not supported|invalid model|NOT_FOUND/i.test(
          lastMessage
        );
        if (modelUnavailable) {
          break;
        }
        const shouldRetry = lastStatus === 429 || lastStatus === 503 || lastStatus === 500 || /high demand|overloaded|try again later|RESOURCE_EXHAUSTED|UNAVAILABLE|capacity|quota/i.test(
          lastMessage
        );
        if (shouldRetry && attempt < backoffMs.length) {
          await sleep(backoffMs[attempt]);
          continue;
        }
        break;
      }
    }
    if (!out.trim() && imageList.length && isChatJob && !prep.proOnly) {
      const textContents = stripInlineImagesFromContents2(contents);
      const lastIdx = textContents.length - 1;
      if (lastIdx >= 0 && textContents[lastIdx]?.role === "user") {
        textContents[lastIdx].parts = [
          ...(textContents[lastIdx].parts || []).filter((p) => !p.inlineData),
          {
            text: "\n(\uC774\uBBF8\uC9C0 \uBD84\uC11D\uC774 \uBE44\uC5B4 \uB2E4\uC2DC \uC2DC\uB3C4\uD569\uB2C8\uB2E4. \uC9C8\uBB38\uC5D0 \uB9DE\uAC8C \uC9E7\uAC8C \uB2F5\uD558\uC138\uC694.)"
          }
        ];
      }
      const flashFallback = dedupeModels([
        "gemini-2.5-flash",
        ...modelCandidatesRun
      ]).filter((m) => !/pro/i.test(m));
      for (const model of flashFallback.slice(0, 2)) {
        const r = await callGemini(model, textContents);
        rawText = await r.text();
        if (!r.ok) continue;
        const hit = tryParseResponse(rawText, model);
        if (hit.ok && hit.text) {
          out = hit.text;
          finishReason = hit.finishReason || "";
          usedModel = hit.model || model;
          lastStatus = 200;
          break;
        }
        if (hit.blocked) {
          return {
            ok: false,
            statusCode: 422,
            body: JSON.stringify({ error: { message: hit.message } })
          };
        }
      }
    }
    if (lastStatus !== 200) {
      const overloaded = lastStatus === 429 || lastStatus === 503 || /high demand|overloaded|try again later|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(
        lastMessage
      );
      const modelGone = /no longer available|invalid model|not found/i.test(
        lastMessage
      );
      const friendly = overloaded ? "AI \uC11C\uBC84\uAC00 \uC7A0\uC2DC \uBC14\uC069\uB2C8\uB2E4. 10~20\uCD08 \uB4A4\uC5D0 \uAC19\uC740 \uC9C8\uBB38\uC744 \uB2E4\uC2DC \uBCF4\uB0B4 \uC8FC\uC138\uC694. (\uC0AC\uC9C4\uC774 \uB9CE\uC73C\uBA74 \uD68C\uB85C\uB3C4 1\uC7A5\uB9CC \uCCA8\uBD80\uD574 \uBCF4\uC138\uC694.)" : modelGone ? "AI \uBAA8\uB378 \uC5F0\uACB0\uC5D0 \uBB38\uC81C\uAC00 \uC788\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694." : lastMessage;
      return {
        ok: false,
        statusCode: lastStatus,
        body: JSON.stringify({ error: { message: friendly } })
      };
    }
    if (!out.trim()) {
      return {
        ok: false,
        statusCode: 502,
        body: JSON.stringify({
          error: {
            message: "AI\uAC00 \uB2F5\uBCC0\uC744 \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. 10\uCD08 \uB4A4 \uAC19\uC740 \uC9C8\uBB38\uC744 \uB2E4\uC2DC \uBCF4\uB0B4 \uC8FC\uC138\uC694. (\uC0AC\uC9C4\uC774 \uB9CE\uC73C\uBA74 \uD68C\uB85C\uB3C4 1\uC7A5\uB9CC \uCCA8\uBD80\uD574 \uBCF4\uC138\uC694.)"
          }
        })
      };
    }
    const contFlags = {
      isChatJob,
      isReportJsonJob: prep.isReportJsonJob,
      isTeacherDraftJob: prep.isTeacherDraftJob
    };
    for (let i = 0; i < maxContinues && needsContinueForPrep(finishReason, out, contFlags); i++) {
      const continueUserText = prep.isReportJsonJob ? "JSON\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4. \uB04A\uAE34 \uC704\uCE58\uBD80\uD130 \uC720\uD6A8\uD55C JSON\uB9CC \uC774\uC5B4 \uC644\uC131\uD558\uC138\uC694. \uBC18\uBCF5\uD558\uC9C0 \uB9C8\uC138\uC694." : prep.isTeacherDraftJob ? "\uD53C\uB4DC\uBC31 \uCD08\uC548\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4. ## \uBCF4\uC644\xB7## \uC548\uC804\uAE4C\uC9C0 \uAC1C\uC694\uD615\uC73C\uB85C \uC774\uC5B4 \uC644\uACB0\uD558\uC138\uC694." : isChatJob ? "\uB2F5\uBCC0\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4. ## \uD575\uC2EC\xB7## \uD560 \uC77C\uAE4C\uC9C0 \uC774\uC5B4 \uC644\uACB0\uD558\uC138\uC694. \uBC18\uBCF5\uD558\uC9C0 \uB9C8\uC138\uC694." : "\uBC29\uAE08 \uB2F5\uBCC0\uC744 \uC774\uC5B4\uC11C \uACC4\uC18D \uC791\uC131\uD574\uC918. \uB04A\uAE34 \uC9C0\uC810\uBD80\uD130 \uC644\uACB0\uD574\uC918.";
      contents.push({
        role: "model",
        parts: [{ text: out.split("\n").slice(-40).join("\n") }]
      });
      contents.push({
        role: "user",
        parts: [{ text: continueUserText }]
      });
      const r2 = await callGemini(
        usedModel || modelCandidatesRun[0],
        stripInlineImagesFromContents2(contents)
      );
      const raw2 = await r2.text();
      if (!r2.ok) break;
      const next = extractTextAndFinish(raw2);
      const chunk = next.text || "";
      if (chunk) out = `${out}
${chunk}`.trim();
      finishReason = next.finishReason || "";
    }
    if (needsContinueForPrep(finishReason, out, {
      isChatJob,
      isReportJsonJob: prep.isReportJsonJob,
      isTeacherDraftJob: prep.isTeacherDraftJob
    })) {
    }
    const refineOptOut = String(env.GEMINI_DISABLE_REFINE || "").trim() === "1" || String(env.GEMINI_DISABLE_REFINE || "").trim().toLowerCase() === "true";
    const refineEnabled = !refineOptOut && (!serverlessCompact || String(env.GEMINI_ENABLE_REFINE || "").trim() === "1");
    const isReportJsonJob = /최종 보고서|SWOT|종합 피드백/i.test(
      String(contextDescription || "")
    );
    const refineShouldRun = refineEnabled && out && out.trim() && !isReportJsonJob && !isChatJob && skipRefineBody !== true && hasImages;
    if (refineShouldRun) {
      try {
        const refinePrompt = `\uC544\uB798\uB294 \uB108\uC758 '\uCD08\uC548 \uB2F5\uBCC0'\uC774\uB2E4. \uAC19\uC740 \uC9C8\uBB38/\uC774\uBBF8\uC9C0 \uB9E5\uB77D\uC744 \uC720\uC9C0\uD558\uBA74\uC11C \uCD5C\uC885 \uB2F5\uBCC0\uC744 \uB2E4\uC2DC \uC791\uC131\uD574\uB77C.

\uC911\uC694:
- \uCD08\uC548\uC774 '\uADFC\uAC70 \uBD80\uC871', '\uCD94\uAC00 \uC0AC\uC9C4 \uD544\uC694', \uC9E7\uC740 \uD655\uC778 \uC9C8\uBB38 \uC704\uC8FC\uB77C\uBA74: \uAE38\uC774\uB97C \uB298\uB9AC\uC9C0 \uB9D0\uACE0 \uBB38\uC7A5\uB9CC \uBA85\uD655\uD558\uAC8C \uB2E4\uB4EC\uC5B4\uB77C. \uC0C8\uB85C\uC6B4 \uB2E8\uC790\uBC88\uD638\xB7\uBC30\uC120\xB7\uCE21\uC815\uAC12\uC744 \uCD94\uAC00\uD558\uC9C0 \uB9C8\uB77C.
- \uC774\uBBF8\uC9C0\uC5D0\uC11C \uBCF4\uC774\uC9C0 \uC54A\uB294 \uC0AC\uC2E4\uC744 \uBCF4\uAC15\uD558\uC9C0 \uB9C8\uB77C.
- \uADFC\uAC70\uAC00 \uCDA9\uBD84\uD560 \uB54C\uB9CC \uC544\uB798 \uD615\uC2DD\uC744 \uC720\uC9C0\uD558\uACE0, \uBD80\uC871\uD558\uBA74 2~6\uBB38\uC7A5\uC73C\uB85C \uB05D\uB0B4\uB3C4 \uB41C\uB2E4.

\uAC00\uB2A5\uD558\uBA74 \uC720\uC9C0\uD560 \uD615\uC2DD:
1) \uACB0\uB860 \uC694\uC57D
2) \uAD00\uCC30/\uADFC\uAC70
3) \uBD84\uC11D(\uC6D0\uC778 \uD6C4\uBCF4 \uC6B0\uC120\uC21C\uC704)
4) \uC810\uAC80/\uC870\uCE58 \uC21C\uC11C(\uCCB4\uD06C\uB9AC\uC2A4\uD2B8)
5) \uCD94\uAC00 \uC9C8\uBB38(\uD544\uC694 \uC2DC)

\uCD08\uC548 \uB2F5\uBCC0:
${out}`;
        contents.push({ role: "model", parts: [{ text: out }] });
        contents.push({ role: "user", parts: [{ text: refinePrompt }] });
        const rr = await callGemini(usedModel || modelCandidatesRun[0], contents);
        const rawR = await rr.text();
        if (rr.ok) {
          const refined = extractTextAndFinish(rawR).text || "";
          if (refined.trim()) out = refined.trim();
        }
      } catch {
      }
    }
    if (!out.trim()) {
      return {
        ok: false,
        statusCode: 502,
        body: JSON.stringify({
          error: {
            message: "AI\uAC00 \uBE48 \uC751\uB2F5\uC744 \uBC18\uD658\uD588\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694."
          }
        })
      };
    }
    return {
      ok: true,
      statusCode: 200,
      body: JSON.stringify({
        choices: [{ message: { content: out } }],
        meta: { model: usedModel || primaryModel }
      })
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = /abort|timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(msg) ? "\uC11C\uBC84 \uC751\uB2F5 \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694." : msg;
    return {
      ok: false,
      statusCode: 500,
      body: JSON.stringify({
        error: { message: friendly }
      })
    };
  }
}
function looksTruncatedJson(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  const stripped = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    JSON.parse(stripped);
    return false;
  } catch {
    if (!/\}\s*$/.test(stripped)) return true;
    if ((stripped.match(/"/g) || []).length % 2 !== 0) return true;
    if (!/"swot"\s*:/i.test(stripped) && /"summary"/i.test(stripped)) return true;
    if (/"swot"\s*:\s*\{/.test(stripped) && !/"t"\s*:/i.test(stripped)) return true;
    return true;
  }
}
function looksTruncatedOutline(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const headers = [...t.matchAll(/^##\s+(.+)$/gm)];
  if (headers.length) {
    const last = headers[headers.length - 1];
    const after = t.slice(last.index + last[0].length).trim();
    if (after.length < 10) return true;
    const has = (re) => re.test(t);
    if (has(/##\s*요약/i) && !has(/##\s*(핵심|근거)/i) && t.length > 25) return true;
    if (has(/##\s*(핵심|근거)/i) && !has(/##\s*(할\s*일|지금)/i)) return true;
    if (has(/##\s*총평/i) && !has(/##\s*잘한/i) && t.length > 40) return true;
    if (has(/##\s*잘한/i) && !has(/##\s*보완/i) && t.length > 60) return true;
  }
  const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1] : "";
  if (/^[-*•●]\s+\S/.test(lastLine) && lastLine.length > 4 && !/[.!?。…』」\)]\s*$/.test(lastLine)) {
    return true;
  }
  if (/^##\s+\S/.test(lastLine) && lastLine.length < 20) return true;
  if (t.length > 40 && /[가-힣]$/.test(t) && !/[.!?。…』」\)]\s*$/.test(t)) {
    return true;
  }
  return false;
}
function looksTruncatedText(text, isChatJob = false) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (isChatJob) {
    if (looksTruncatedOutline(t)) return true;
    const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const lastLine = lines.length ? lines[lines.length - 1] : t;
    if (/[:：]\s*$/.test(lastLine) || /[:：]\s*$/.test(t)) return true;
    if (/^[-*•●\d]|^\s*\d+[.)]/.test(lastLine) && lastLine.length > 6 && !/[.!?。…』」\)]\s*$/.test(lastLine)) {
      return true;
    }
    const endsMid = /[가-힣0-9a-zA-Z(,（·]\s*$/.test(t) && !/[.!?。…』」\)]\s*$/.test(t);
    if (endsMid && t.length >= 20) return true;
    if (/확인된\s*근거|②|근거\s*[:：]/.test(t) && !/할\s*일|③|다음\s*할|지금\s*할|해야/i.test(t)) {
      return true;
    }
    return false;
  }
  if (t.length < 120) return false;
  if (/1\)\s*결론\s*요약/i.test(t) && !/5\)\s*추가/i.test(t)) return true;
  if (t.length > 280 && !/[.!?。…』」\)]\s*$/.test(t) && /[가-힣0-9a-zA-Z(,（]\s*$/.test(t)) {
    return true;
  }
  return false;
}
function needsContinueForPrep(finishReason, text, prep) {
  if (/MAX_TOKENS/i.test(String(finishReason || ""))) return true;
  if (prep?.isReportJsonJob) return looksTruncatedJson(text);
  if (prep?.isTeacherDraftJob || prep?.isChatJob) {
    return looksTruncatedText(text, true);
  }
  return looksTruncatedText(text, false);
}
function stripInlineImagesFromContents(contentsArr) {
  return contentsArr.map((turn) => ({
    role: turn.role,
    parts: (turn.parts || []).filter((p) => !p.inlineData)
  }));
}
async function geminiGenerateOnce(prep, model, contents) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": prep.key
      },
      body: JSON.stringify({
        systemInstruction: {
          role: "system",
          parts: [{ text: prep.systemContent }]
        },
        contents,
        generationConfig: {
          temperature: prep.temperature,
          topP: prep.topP,
          maxOutputTokens: prep.maxOutputTokens
        }
      }),
      signal: AbortSignal.timeout(prep.geminiFetchTimeoutMs)
    }
  );
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw;
    try {
      msg = JSON.parse(raw).error?.message || raw;
    } catch {
    }
    return { ok: false, status: res.status, message: String(msg || "") };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, status: 502, message: "invalid_json" };
  }
  const parts = data.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.filter((p) => p && p.thought !== true).map((p) => typeof p?.text === "string" ? p.text : "").join("").trim() : "";
  const finishReason = String(data.candidates?.[0]?.finishReason || "").trim();
  if (!text) return { ok: false, status: 502, message: "empty_response" };
  return { ok: true, text, finishReason };
}
async function finalizeGeminiAnswer(prep, model, text, push, initialFinishReason = "") {
  const cap = prep.isServerlessDeploy ? 2 : 5;
  const maxRounds = Math.min(Math.max(prep.maxContinues || 0, 0), cap);
  let out = String(text || "").trim();
  let finishReason = String(initialFinishReason || "");
  for (let i = 0; i < maxRounds; i++) {
    if (!needsContinueForPrep(finishReason, out, prep)) break;
    push({ event: "status", message: "\uB2F5\uBCC0 \uB9C8\uBB34\uB9AC \uC911\u2026" });
    const contents = [
      ...stripInlineImagesFromContents(prep.contents),
      { role: "model", parts: [{ text: out.slice(-2500) }] },
      {
        role: "user",
        parts: [
          {
            text: prep.isReportJsonJob ? "JSON \uCD9C\uB825\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4. \uB04A\uAE34 \uC704\uCE58\uBD80\uD130 **\uC720\uD6A8\uD55C JSON\uB9CC** \uC774\uC5B4 \uC644\uC131\uD558\uC138\uC694. \uC774\uBBF8 \uCD9C\uB825\uD55C \uBD80\uBD84\uC740 \uBC18\uBCF5\uD558\uC9C0 \uB9C8\uC138\uC694." : prep.isTeacherDraftJob ? "\uAD50\uC0AC \uD53C\uB4DC\uBC31 \uCD08\uC548\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4. \uB04A\uAE34 \uC704\uCE58\uBD80\uD130 \uB9C8\uD06C\uB2E4\uC6B4 \uAC1C\uC694\uD615(##\xB7\uBD88\uB9BF)\uC73C\uB85C \uC774\uC5B4 \uC4F0\uC138\uC694. \uBC18\uBCF5\uD558\uC9C0 \uB9C8\uC138\uC694." : prep.isChatJob ? prep.wantsDetail ? "\uB2F5\uBCC0\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4. \uB04A\uAE34 \uBD88\uB9BF\xB7\uD56D\uBAA9\uBD80\uD130 \uB05D\uAE4C\uC9C0 \uC774\uC5B4 \uC4F0\uC138\uC694. \uB9C8\uD06C\uB2E4\uC6B4 \uAC1C\uC694\uD615 \uC720\uC9C0. \uBC18\uBCF5\uD558\uC9C0 \uB9C8\uC138\uC694." : "\uB2F5\uBCC0\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4. \uB04A\uAE34 **\uB9C8\uC9C0\uB9C9 \uBD88\uB9BF/\uBB38\uC7A5\uB9CC** \uC774\uC5B4 \uC644\uACB0\uD558\uC138\uC694. ## \uD575\uC2EC\xB7## \uD560 \uC77C\uC774 \uC5C6\uC73C\uBA74 \uCD94\uAC00\uD558\uACE0, \uC788\uC73C\uBA74 \uB04A\uAE34 \uBD80\uBD84\uB9CC 1~2\uBB38\uC7A5\uC73C\uB85C \uB9C8\uBB34\uB9AC\uD558\uC138\uC694. \uBC18\uBCF5\uD558\uC9C0 \uB9C8\uC138\uC694." : "\uBC29\uAE08 \uB2F5\uBCC0\uC744 \uC774\uC5B4\uC11C \uACC4\uC18D \uC791\uC131\uD574\uC918. \uB04A\uAE34 \uC9C0\uC810\uBD80\uD130 \uC774\uC5B4\uC11C. \uB05D\uAE4C\uC9C0 \uC644\uACB0\uD574\uC918."
          }
        ]
      }
    ];
    const hit = await geminiGenerateOnce(prep, model, contents);
    if (!hit.ok || !hit.text) break;
    const chunk = String(hit.text).trim();
    if (chunk) {
      out = `${out}
${chunk}`.trim();
      push({ event: "chunk", text: chunk });
    }
    finishReason = hit.finishReason || "";
  }
  return out;
}
function extractStreamChunkText(obj) {
  const parts = obj?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.filter((p) => p && p.thought !== true).map((p) => typeof p?.text === "string" ? p.text : "").join("");
}
async function consumeGeminiSseStream(body, onText) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let finishReason = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      let jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      if (!jsonStr || jsonStr === "[" || jsonStr === "]") continue;
      try {
        const data = JSON.parse(jsonStr);
        const fr = String(data.candidates?.[0]?.finishReason || "").trim();
        if (fr) finishReason = fr;
        const chunk = extractStreamChunkText(data);
        if (chunk) {
          full += chunk;
          onText(chunk);
        }
      } catch {
      }
    }
  }
  const tail = buf.trim();
  if (tail && tail !== "data: [DONE]") {
    try {
      let jsonStr = tail.startsWith("data:") ? tail.slice(5).trim() : tail;
      const data = JSON.parse(jsonStr);
      const fr = String(data.candidates?.[0]?.finishReason || "").trim();
      if (fr) finishReason = fr;
      const chunk = extractStreamChunkText(data);
      if (chunk) {
        full += chunk;
        onText(chunk);
      }
    } catch {
    }
  }
  return { text: full.trim(), finishReason };
}
async function streamOneGeminiModel(prep, model, push) {
  if (prep.preferOneshot) {
    push({ event: "status", message: "Pro \uBD84\uC11D \uC911\u2026" });
    const hit = await geminiGenerateOnce(prep, model, prep.contents);
    if (!hit.ok) {
      return { ok: false, status: hit.status, message: hit.message };
    }
    const text2 = await finalizeGeminiAnswer(
      prep,
      model,
      hit.text,
      push,
      hit.finishReason
    );
    return { ok: true, text: text2, model };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": prep.key
    },
    body: JSON.stringify({
      systemInstruction: {
        role: "system",
        parts: [{ text: prep.systemContent }]
      },
      contents: prep.contents,
      generationConfig: {
        temperature: prep.temperature,
        topP: prep.topP,
        maxOutputTokens: prep.maxOutputTokens
      }
    }),
    signal: AbortSignal.timeout(prep.geminiFetchTimeoutMs)
  });
  if (!res.ok) {
    const raw = await res.text();
    let msg = raw;
    try {
      msg = JSON.parse(raw).error?.message || raw;
    } catch {
    }
    return { ok: false, status: res.status, message: String(msg || "") };
  }
  if (!res.body) return { ok: false, status: 502, message: "empty_response" };
  const streamed = await consumeGeminiSseStream(res.body, (chunk) => {
    push({ event: "chunk", text: chunk });
  });
  if (!streamed.text) return { ok: false, status: 502, message: "empty_response" };
  const text = await finalizeGeminiAnswer(
    prep,
    model,
    streamed.text,
    push,
    streamed.finishReason
  );
  return { ok: true, text, model };
}
async function runGeminiChatBufferedFallback(body, env, push) {
  push({ event: "status", message: "Pro \uBAA8\uB378\uB85C \uBD84\uC11D \uC911\u2026" });
  const pingMs = 900;
  const pingTimer = setInterval(() => push({ event: "ping" }), pingMs);
  try {
    const result = await runGeminiChatProxy({ ...body, stream: false }, env);
    clearInterval(pingTimer);
    if (!result.ok || result.statusCode !== 200) {
      let msg = "\uC694\uCCAD\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.";
      try {
        msg = JSON.parse(result.body).error?.message || msg;
      } catch {
      }
      push({ event: "error", message: msg });
      return;
    }
    let text = "";
    let model = "";
    try {
      const j = JSON.parse(result.body);
      text = j.choices?.[0]?.message?.content || "";
      model = j.meta?.model || "";
    } catch {
    }
    if (!String(text).trim()) {
      push({ event: "error", message: "AI\uAC00 \uBE48 \uB2F5\uBCC0\uC744 \uBC18\uD658\uD588\uC2B5\uB2C8\uB2E4." });
      return;
    }
    push({ event: "done", text: String(text).trim(), model: model || void 0 });
  } catch (e) {
    clearInterval(pingTimer);
    push({
      event: "error",
      message: e instanceof Error ? e.message : String(e)
    });
  }
}
async function runGeminiChatStreamToPush(body, env, push) {
  const prep = await prepareGeminiChatRequest(body, env);
  if (!prep.ok) {
    let msg = "\uC694\uCCAD\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.";
    try {
      msg = JSON.parse(prep.body).error?.message || msg;
    } catch {
    }
    push({ event: "error", message: msg });
    return;
  }
  const proMode = prep.modelCandidatesRun.some((m) => /pro/i.test(m));
  push({
    event: "status",
    message: proMode ? "Pro \uBAA8\uB378\uB85C \uBD84\uC11D \uC911\u2026" : "\uD68C\uB85C\xB7\uC0AC\uC9C4\uC744 \uBD84\uC11D\uD558\uB294 \uC911\uC785\uB2C8\uB2E4\u2026"
  });
  const pingTimer = setInterval(() => push({ event: "ping" }), proMode ? 800 : 2e3);
  let lastMsg = "AI\uAC00 \uB2F5\uBCC0\uC744 \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
  try {
    if (prep.isReportJsonJob || prep.isTeacherDraftJob) {
      clearInterval(pingTimer);
      await runGeminiChatBufferedFallback(body, env, push);
      return;
    }
    const maxAttempts = prep.isServerlessDeploy ? 4 : 3;
    for (const model of prep.modelCandidatesRun) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          push({
            event: "status",
            message: `\uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\u2026 (${attempt + 1}/${maxAttempts})`
          });
          await new Promise((r) => setTimeout(r, 2500 + attempt * 1500));
        }
        try {
          const hit = await streamOneGeminiModel(prep, model, push);
          if (hit.ok && hit.text) {
            clearInterval(pingTimer);
            push({ event: "done", text: hit.text, model: hit.model || model });
            return;
          }
          lastMsg = hit.message || lastMsg;
          const retryable = hit.status === 429 || hit.status === 503 || hit.status === 502 || hit.status === 504 || /overloaded|unavailable|empty_response|timeout|timed out|abort/i.test(
            lastMsg
          );
          if (!retryable) break;
        } catch (e) {
          lastMsg = e instanceof Error ? e.message : String(e);
          if (!/timeout|abort|503|429|504|overloaded|timed out|deadline/i.test(
            lastMsg
          )) {
            break;
          }
        }
      }
    }
    clearInterval(pingTimer);
    await runGeminiChatBufferedFallback(body, env, push);
  } catch {
    clearInterval(pingTimer);
    await runGeminiChatBufferedFallback(body, env, push);
  }
}
async function runGeminiChatWithHeartbeat(body, env, push) {
  await runGeminiChatStreamToPush(body, env, push);
}

// server/deploy-env.mjs
function deployEnv(extra = {}) {
  const onVercel = Boolean(process.env.VERCEL);
  return {
    ...process.env,
    ...extra,
    VERCEL: onVercel ? "1" : process.env.VERCEL || "",
    ...onVercel ? {
      GEMINI_SERVERLESS_COMPACT: extra.GEMINI_SERVERLESS_COMPACT ?? process.env.GEMINI_SERVERLESS_COMPACT ?? "0",
      GEMINI_FETCH_TIMEOUT_MS: extra.GEMINI_FETCH_TIMEOUT_MS ?? process.env.GEMINI_FETCH_TIMEOUT_MS ?? "58000",
      GEMINI_PRO_ONLY: extra.GEMINI_PRO_ONLY ?? process.env.GEMINI_PRO_ONLY ?? "1"
    } : {}
  };
}
export {
  deployEnv,
  runGeminiChatWithHeartbeat
};
