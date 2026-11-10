const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("DAMMPULSE_API_URL", "https://dammpulse-api-production.up.railway.app");
