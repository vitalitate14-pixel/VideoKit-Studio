// Only failure of the development entry page may replace the main window.
// Removed preview iframes and failed local media must never reload the app.
function createDevServerLoadPolicy(devServerURL, maxRetries = 25) {
    const origin = new URL(devServerURL).origin;
    let retries = 0;
    let fallback = false;
    return {
        failed({ errorCode, validatedURL, isMainFrame }) {
            if (fallback || !isMainFrame || errorCode === -3) return 'ignore';
            try {
                const url = new URL(validatedURL);
                if (url.origin !== origin || url.pathname !== '/') return 'ignore';
            } catch { return 'ignore'; }
            if (retries++ < maxRetries) return 'retry';
            fallback = true;
            return 'fallback';
        },
        get canRetry() { return !fallback; },
    };
}

module.exports = { createDevServerLoadPolicy };
