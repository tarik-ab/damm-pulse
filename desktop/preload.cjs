const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("DAMMPLUS_API_URL", "https://dammpulse-api-production.up.railway.app");
