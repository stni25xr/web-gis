(function () {
    const DB_NAME = "ifc_viewer";
    const STORE_NAME = "models";
    const KEY = "default";
    const LOCAL_KEY = "ifc_data_json";

    function openDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: "id" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function saveDataJson(dataJson) {
        try {
            localStorage.setItem(LOCAL_KEY, dataJson);
        } catch (e) {
            // Ignore localStorage failures (quota or privacy mode)
        }

        try {
            const db = await openDb();
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            store.put({ id: KEY, dataJson, savedAt: Date.now() });
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } catch (e) {
            return false;
        }
    }

    async function loadDataJson() {
        try {
            const db = await openDb();
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(KEY);
            return new Promise((resolve) => {
                req.onsuccess = () => {
                    if (req.result && req.result.dataJson) {
                        resolve(req.result.dataJson);
                        return;
                    }
                    try {
                        const fallback = localStorage.getItem(LOCAL_KEY);
                        resolve(fallback || null);
                    } catch (e) {
                        resolve(null);
                    }
                };
                req.onerror = () => {
                    try {
                        const fallback = localStorage.getItem(LOCAL_KEY);
                        resolve(fallback || null);
                    } catch (e) {
                        resolve(null);
                    }
                };
            });
        } catch (e) {
            try {
                const fallback = localStorage.getItem(LOCAL_KEY);
                return fallback || null;
            } catch (err) {
                return null;
            }
        }
    }

    window.ifcStorage = {
        saveDataJson,
        loadDataJson,
    };
})();
