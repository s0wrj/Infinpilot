function base64ToText(base64) {
    if (!base64) {
        return '';
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    return new TextDecoder().decode(bytes);
}

export async function runtimeFetch(url, options = {}) {
    const response = await browser.runtime.sendMessage({
        action: 'fetchWithProxy',
        url,
        options
    });

    if (!response?.success) {
        throw new Error(response?.error || 'Background fetch failed.');
    }

    const textBody = base64ToText(response.data);

    return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        statusText: response.statusText || '',
        headers: new Headers(response.headers || {}),
        text: async () => textBody,
        json: async () => textBody ? JSON.parse(textBody) : null
    };
}
