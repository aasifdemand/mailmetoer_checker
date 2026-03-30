const axios = require('axios');
require('dotenv').config();

class ProxyManager {
    constructor() {
        this.proxies = [];
        this.currentIndex = 0;
        this.apiKey = process.env.WEBSHARE_API_KEY;
    }

    async refreshProxies() {
        if (!this.apiKey || this.apiKey === 'YOUR_WEBSHARE_API_KEY') {
            console.warn('⚠️ WEBSHARE_API_KEY not configured. Using direct connection.');
            return [];
        }

        try {
            console.log('Fetching fresh proxies from Webshare...');
            const response = await axios.get('https://proxy.webshare.io/api/v2/proxy/list/', {
                headers: {
                    'Authorization': `Token ${this.apiKey}`
                },
                params: {
                    mode: 'direct',
                    valid: true
                }
            });

            if (response.data && response.data.results) {
                this.proxies = response.data.results.map(p => ({
                    host: p.proxy_address,
                    port: p.port,
                    username: p.username,
                    password: p.password
                }));
                console.log(`✅ Loaded ${this.proxies.length} proxies.`);
            }
        } catch (err) {
            console.error('❌ Proxy Fetch Error:', err.response?.data || err.message);
        }
        return this.proxies;
    }

    getNext() {
        if (this.proxies.length === 0) return null;
        const p = this.proxies[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
        return p;
    }
}

module.exports = new ProxyManager();
