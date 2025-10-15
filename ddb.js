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

async function fetchTerm(id) {
    if (termCache.has(id)) {
        return termCache.get(id);
    }
    const res = await fetch(`${apiUrl}/go/${encodeURIComponent(id)}`);
    const data = res.ok ? await res.json() : null;
    if (data) {
        termCache.set(id, data);
    }
    return data;
}

async function fetchChildren(id) {
    if (childrenCache.has(id)) {
        return childrenCache.get(id);
    }
    const res = await fetch(`${apiUrl}/go/children/${encodeURIComponent(id)}`);
    const data = res.ok ? await res.json() : [];
    childrenCache.set(id, data);
    return data;
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

async function showStrains(term) {
    const label = document.getElementById("selected-go-label");
    const list = document.getElementById("strain-list");

    label.textContent = `${term.name} (${term.go_id})`;
    
    // Check cache first
    if (strainsCache.has(term.go_id)) {
        const strains = strainsCache.get(term.go_id);
        renderStrains(strains, list);
        return;
    }
    
    list.innerHTML = "<li class='text-gray-500'>Loading strains...</li>";

    try {
        const res = await fetch(`${apiUrl}/go/${encodeURIComponent(term.go_id)}/mmrrc-strains`);
        const strains = res.ok ? await res.json() : [];
        
        // Cache the results
        strainsCache.set(term.go_id, strains);
        
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
    } else {
        // Use DocumentFragment for better performance when rendering many items
        const fragment = document.createDocumentFragment();
        
        for (const strain of strains) {
            const li = document.createElement("li");
            const link = document.createElement("a");
            link.href = `https://www.mmrrc.org/catalog/sds.php?mmrrc_id=${strain.mmrrc_id}`;
            link.textContent = strain.mmrrc_id;
            link.target = "_blank"; // Open in new tab
            link.rel = "noopener noreferrer"; // Security best practice
            link.classList.add("hover:underline", "text-blue-600");
            li.appendChild(link);
            fragment.appendChild(li);
        }
        
        list.appendChild(fragment);
    }
}

async function init() {
    const tree = document.getElementById("go-tree");
    
    // Load root terms in parallel for faster initial load
    const rootTermsPromises = ROOT_TERMS.map(id => fetchTerm(id));
    const rootTerms = await Promise.all(rootTermsPromises);
    
    for (const term of rootTerms) {
        if (term) buildNode(term, tree);
    }
}

init();