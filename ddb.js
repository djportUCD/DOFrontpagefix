// Enter the url of the backend api
const apiUrl = 'http://localhost:3000/api'

const ROOT_TERMS = [
    "GO:0008150",
    "GO:0005575",
    "GO:0003674"
];

// Cache to prevent redundant API calls
const termCache = new Map();
const childrenCache = new Map();
const strainsCache = new Map();

// Cache expiry (30 minutes)
const CACHE_EXPIRY = 30 * 60 * 1000;

// Request deduplication: prevent duplicate simultaneous requests
const pendingRequests = new Map();

// Prefetch queue for predictive loading
const prefetchQueue = new Set();

async function fetchTerm(id) {
    // Check cache with expiry
    const cached = termCache.get(id);
    if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY) {
        return cached.data;
    }
    
    // Request deduplication: if already fetching, return the same promise
    const requestKey = `term-${id}`;
    if (pendingRequests.has(requestKey)) {
        return pendingRequests.get(requestKey);
    }
    
    const promise = fetch(`${apiUrl}/go/${encodeURIComponent(id)}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
            if (data) {
                termCache.set(id, { data, timestamp: Date.now() });
            }
            pendingRequests.delete(requestKey);
            return data;
        })
        .catch(error => {
            pendingRequests.delete(requestKey);
            console.error('Error fetching term:', error);
            return null;
        });
    
    pendingRequests.set(requestKey, promise);
    return promise;
}

async function fetchChildren(id) {
    // Check cache with expiry
    const cached = childrenCache.get(id);
    if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY) {
        return cached.data;
    }
    
    // Request deduplication
    const requestKey = `children-${id}`;
    if (pendingRequests.has(requestKey)) {
        return pendingRequests.get(requestKey);
    }
    
    const promise = fetch(`${apiUrl}/go/children/${encodeURIComponent(id)}`)
        .then(res => res.ok ? res.json() : [])
        .then(data => {
            childrenCache.set(id, { data, timestamp: Date.now() });
            pendingRequests.delete(requestKey);
            return data;
        })
        .catch(error => {
            pendingRequests.delete(requestKey);
            console.error('Error fetching children:', error);
            return [];
        });
    
    pendingRequests.set(requestKey, promise);
    return promise;
}

async function buildNode(term, container) {
    const li = document.createElement("li");
    li.dataset.id = term.go_id;
    li.dataset.expanded = "false";
    
    const textSpan = document.createElement("span");
    textSpan.classList.add("cursor-pointer", "go-term-text");
    textSpan.textContent = term.name || term.go_id;

    const childrenUL = document.createElement("ul");
    childrenUL.classList.add("ml-4", "space-y-1", "hidden");
    
    li.appendChild(textSpan);
    li.appendChild(childrenUL);

    // Prefetch strains on hover for instant display
    textSpan.addEventListener('mouseenter', () => {
        if (!strainsCache.has(term.go_id) && !prefetchQueue.has(term.go_id)) {
            prefetchQueue.add(term.go_id);
            prefetchStrains(term.go_id);
        }
    });

    textSpan.onclick = async (e) => {
        e.stopPropagation();
        showStrains(term);

        const expanded = li.dataset.expanded === "true";
        if (!expanded) {
            if (!li.dataset.loaded) {
                // Show loading indicator
                const loadingLi = document.createElement("li");
                loadingLi.textContent = "Loading...";
                loadingLi.classList.add("text-gray-500", "italic");
                childrenUL.appendChild(loadingLi);
                childrenUL.classList.remove("hidden");
                
                try {
                    const children = await fetchChildren(term.go_id);
                    
                    // Fetch all child terms in parallel for much better performance
                    const childTermsPromises = children.map(child => fetchTerm(child.child_go_id));
                    const childTerms = await Promise.all(childTermsPromises);
                    
                    // Remove loading indicator
                    childrenUL.removeChild(loadingLi);
                    
                    // Build nodes for all children
                    for (const childTerm of childTerms) {
                        if (childTerm) await buildNode(childTerm, childrenUL);
                    }
                    
                    li.dataset.loaded = "true";
                    
                    // Prefetch children's children for the first few nodes (predictive loading)
                    if (childTerms.length > 0 && childTerms.length <= 5) {
                        setTimeout(() => {
                            childTerms.forEach(child => {
                                if (child) fetchChildren(child.go_id);
                            });
                        }, 500);
                    }
                } catch (error) {
                    childrenUL.innerHTML = "<li class='text-red-500'>Error loading children</li>";
                    console.error('Error loading children:', error);
                }
            } else {
                childrenUL.classList.remove("hidden");
            }
            li.dataset.expanded = "true";
        } else {
            childrenUL.classList.add("hidden");
            li.dataset.expanded = "false";
        }
    };

    container.appendChild(li);
}

// Prefetch strains without blocking UI
async function prefetchStrains(goId) {
    try {
        const requestKey = `strains-${goId}`;
        if (pendingRequests.has(requestKey)) {
            return;
        }
        
        const promise = fetch(`${apiUrl}/go/${encodeURIComponent(goId)}/mmrrc-strains`)
            .then(res => res.ok ? res.json() : [])
            .then(strains => {
                strainsCache.set(goId, { data: strains, timestamp: Date.now() });
                pendingRequests.delete(requestKey);
                prefetchQueue.delete(goId);
            })
            .catch(error => {
                pendingRequests.delete(requestKey);
                prefetchQueue.delete(goId);
                console.error('Error prefetching strains:', error);
            });
        
        pendingRequests.set(requestKey, promise);
    } catch (error) {
        console.error('Error in prefetchStrains:', error);
    }
}

async function showStrains(term) {
    const label = document.getElementById("selected-go-label");
    const list = document.getElementById("strain-list");

    label.textContent = `${term.name} (${term.go_id})`;
    
    // Check cache first (with expiry)
    const cached = strainsCache.get(term.go_id);
    if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY) {
        renderStrains(cached.data, list);
        return;
    }
    
    list.innerHTML = "<li class='text-gray-500'>Loading strains...</li>";

    try {
        const requestKey = `strains-${term.go_id}`;
        
        // Check if already fetching
        if (pendingRequests.has(requestKey)) {
            const strains = await pendingRequests.get(requestKey);
            renderStrains(strains || [], list);
            return;
        }
        
        const promise = fetch(`${apiUrl}/go/${encodeURIComponent(term.go_id)}/mmrrc-strains`)
            .then(res => res.ok ? res.json() : [])
            .then(strains => {
                strainsCache.set(term.go_id, { data: strains, timestamp: Date.now() });
                pendingRequests.delete(requestKey);
                return strains;
            });
        
        pendingRequests.set(requestKey, promise);
        const strains = await promise;
        
        renderStrains(strains, list);
    } catch (error) {
        list.innerHTML = "<li class='text-red-500'>Error loading strains.</li>";
        console.error('Error fetching strains:', error);
    }
}

function renderStrains(strains, list) {
    list.innerHTML = "";
    
    if (strains.length === 0) {
        list.innerHTML = "<li class='text-gray-500'>No strains linked to this term.</li>";
        return;
    }
    
    // Use DocumentFragment for better performance when rendering many items
    const fragment = document.createDocumentFragment();
    
    // Virtual scrolling for large lists (only render visible items initially)
    const INITIAL_RENDER_COUNT = 100;
    const strainsToRender = strains.slice(0, INITIAL_RENDER_COUNT);
    
    for (const strain of strainsToRender) {
        const li = document.createElement("li");
        const link = document.createElement("a");
        link.href = `https://www.mmrrc.org/catalog/sds.php?mmrrc_id=${strain.mmrrc_id}`;
        link.textContent = strain.mmrrc_id;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.classList.add("hover:underline", "text-blue-600");
        li.appendChild(link);
        fragment.appendChild(li);
    }
    
    list.appendChild(fragment);
    
    // If there are more strains, lazy load them
    if (strains.length > INITIAL_RENDER_COUNT) {
        const loadMoreLi = document.createElement("li");
        loadMoreLi.textContent = `+ ${strains.length - INITIAL_RENDER_COUNT} more strains (click to load)`;
        loadMoreLi.classList.add("text-blue-600", "cursor-pointer", "hover:underline", "font-semibold", "mt-2");
        loadMoreLi.onclick = () => {
            loadMoreLi.remove();
            const remainingFragment = document.createDocumentFragment();
            
            for (let i = INITIAL_RENDER_COUNT; i < strains.length; i++) {
                const strain = strains[i];
                const li = document.createElement("li");
                const link = document.createElement("a");
                link.href = `https://www.mmrrc.org/catalog/sds.php?mmrrc_id=${strain.mmrrc_id}`;
                link.textContent = strain.mmrrc_id;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.classList.add("hover:underline", "text-blue-600");
                li.appendChild(link);
                remainingFragment.appendChild(li);
            }
            
            list.appendChild(remainingFragment);
        };
        list.appendChild(loadMoreLi);
    }
}

async function init() {
    const tree = document.getElementById("go-tree");
    
    // Show loading indicator
    tree.innerHTML = "<li class='text-gray-500 italic'>Loading GO terms...</li>";
    
    try {
        // Load root terms in parallel for faster initial load
        const rootTermsPromises = ROOT_TERMS.map(id => fetchTerm(id));
        const rootTerms = await Promise.all(rootTermsPromises);
        
        tree.innerHTML = "";
        
        for (const term of rootTerms) {
            if (term) await buildNode(term, tree);
        }
        
        // Preload first level of children for root terms (predictive loading)
        setTimeout(() => {
            rootTerms.forEach(term => {
                if (term) fetchChildren(term.go_id);
            });
        }, 1000);
    } catch (error) {
        tree.innerHTML = "<li class='text-red-500'>Error loading GO terms. Please refresh.</li>";
        console.error('Error initializing:', error);
    }
}

// Clear expired cache entries periodically
setInterval(() => {
    const now = Date.now();
    
    for (const [key, value] of termCache.entries()) {
        if (now - value.timestamp > CACHE_EXPIRY) {
            termCache.delete(key);
        }
    }
    
    for (const [key, value] of childrenCache.entries()) {
        if (now - value.timestamp > CACHE_EXPIRY) {
            childrenCache.delete(key);
        }
    }
    
    for (const [key, value] of strainsCache.entries()) {
        if (now - value.timestamp > CACHE_EXPIRY) {
            strainsCache.delete(key);
        }
    }
}, 5 * 60 * 1000); // Check every 5 minutes

init();