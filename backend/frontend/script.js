const userInput = document.getElementById('userInput');
const sendButton = document.getElementById('sendButton');
const chatHistory = document.getElementById('chatHistory');
const taskListDiv = document.getElementById('taskList'); // Target for dynamic tasks
const modelSelect = document.getElementById('modelSelect');
const liveViewFrame = document.getElementById('liveViewFrame'); // IFrame
const liveViewStatus = document.getElementById('liveViewStatus'); // IFrame status

// --- WebSocket Connection ---
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.hostname}:8000/ws`;
let socket;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectInterval = 5000; // 5 seconds

// --- noVNC Configuration ---
const vncHost = window.location.hostname;
const vncPort = 6080; // Standard noVNC port from docker-compose
const vncUrl = `http://${vncHost}:${vncPort}/vnc.html?autoconnect=true&resize=scale&path=websockify`;

function connectWebSocket() {
    if (reconnectAttempts >= maxReconnectAttempts) {
        console.error("Max reconnect attempts reached.");
        appendMessage(chatHistory, 'Error: Could not connect to agent backend. Max reconnect attempts reached. Please check server and refresh.', 'agent-error');
        showLiveViewStatus("Connection Failed");
        return;
    }
    console.log(`Connecting to WebSocket at ${wsUrl} (Attempt ${reconnectAttempts + 1})...`);
    showLiveViewStatus(`Connecting... (Attempt ${reconnectAttempts + 1})`);

    if (reconnectAttempts === 0) {
        chatHistory.innerHTML = '<p class="message agent-activity">Connecting to agent...</p>';
        // Initialize task list differently now
        taskListDiv.innerHTML = '<p class="message agent-activity">Waiting for connection...</p>';
    }

    socket = new WebSocket(wsUrl);

    socket.onopen = (event) => {
        console.log('WebSocket connection opened:', event);
        reconnectAttempts = 0;
        clearInitialMessages();
        appendMessage(chatHistory, 'Connected to agent backend. Ready for input.', 'agent-activity');
        // Set initial task list message for dynamic state
        taskListDiv.innerHTML = '<p class="message agent-activity">No tasks planned yet.</p>';
        loadLiveView();
    };

    socket.onmessage = (event) => {
        console.log('WebSocket message received:', event.data);
        const message = event.data;
        let messageText = message;
        let messageType = 'agent-activity';

        clearInitialMessages(); // Clear placeholders on first message

        // --- Message Routing ---
        if (message.startsWith('Agent Task Update:')) {
            // Handle task list updates separately
            const taskDataJson = message.substring('Agent Task Update:'.length).trim();
            try {
                const tasks = JSON.parse(taskDataJson);
                renderTaskList(tasks); // Call the rendering function
            } catch (e) {
                console.error("Failed to parse task update JSON:", e);
                appendMessage(chatHistory, `Agent Error: Corrupted task update received.`, 'agent-error');
            }
            // Do not display the raw task update message in the chat history
            return; // Stop processing this message here
        } else if (message.startsWith('Agent: Final Response:')) {
            messageText = message.substring('Agent: Final Response:'.length).trim();
            messageType = 'agent-final';
            appendMessage(chatHistory, `**Final Result:**\n${messageText}`, messageType);
        } else if (message.startsWith('Agent Error:')) {
            messageText = `Error: ${message.substring('Agent Error:'.length).trim()}`;
            messageType = 'agent-error';
            appendMessage(chatHistory, messageText, messageType);
        } else if (message.startsWith('Agent Warning:')) {
             messageText = `Warning: ${message.substring('Agent Warning:'.length).trim()}`;
             messageType = 'agent-warning';
             appendMessage(chatHistory, messageText, messageType);
        } else if (message.startsWith('Agent: ')) {
             messageText = message.substring('Agent:'.length).trim();
             messageType = 'agent-activity';
             // Prevent duplicate "Workflow complete." messages
             const lastMsgContent = chatHistory.lastElementChild?.textContent || "";
             if ((messageText.includes("Workflow complete") || messageText.includes("Workflow finished")) &&
                 (lastMsgContent.includes("Workflow complete") || lastMsgContent.includes("Workflow finished"))) {
                // Skip duplicate
             } else {
                  appendMessage(chatHistory, messageText, messageType);
             }
        } else {
            // Unknown message format
             console.log("Received unhandled message format:", message)
            appendMessage(chatHistory, `Raw Message: ${message}`, 'agent-activity');
        }
    };

    socket.onclose = (event) => {
        console.log(`WebSocket closed: Code=${event.code}, Reason='${event.reason}', Clean=${event.wasClean}`);
        hideLiveViewStatus();
        liveViewFrame.src = 'about:blank';
        if (!event.wasClean && event.code !== 1000 && event.code !== 1001 && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            const reconnectMsg = `Connection closed. Reconnecting... (${reconnectAttempts}/${maxReconnectAttempts})`;
            appendMessage(chatHistory, reconnectMsg, 'agent-error');
            showLiveViewStatus("Reconnecting...");
            setTimeout(connectWebSocket, reconnectInterval);
        } else if (reconnectAttempts >= maxReconnectAttempts) {
             appendMessage(chatHistory, 'Connection lost. Max reconnection attempts reached.', 'agent-error');
             showLiveViewStatus("Connection Failed");
        } else {
             appendMessage(chatHistory, 'Connection closed.', 'agent-activity');
             showLiveViewStatus("Disconnected");
        }
         // Clear task list on disconnect? Optional.
         // taskListDiv.innerHTML = '<p class="message agent-error">Disconnected.</p>';
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        appendMessage(chatHistory, 'WebSocket error occurred. Check console for details.', 'agent-error');
        showLiveViewStatus("Connection Error");
    };
}

// --- Initial Message Clearing ---
function clearInitialMessages() {
    const initialPlaceholders = [
        "Connecting to agent...",
        "Waiting for connection...",
        "Welcome! Select a model and enter your query."
    ];
    if (chatHistory.children.length === 1 && initialPlaceholders.some(msg => chatHistory.firstElementChild.textContent.includes(msg))) {
        chatHistory.innerHTML = '';
    }
     // Clear task list initial message too if needed
     const initialTaskMessages = ["Waiting for connection...", "No tasks planned yet."];
     if (taskListDiv.children.length === 1 && initialTaskMessages.some(msg => taskListDiv.firstElementChild.textContent.includes(msg))) {
          // Don't clear if it's already showing tasks
     }
}

// --- Live View Handling ---
function loadLiveView() {
    console.log(`Setting iframe source to: ${vncUrl}`);
    showLiveViewStatus("Loading VNC...");
    liveViewFrame.src = vncUrl;
    liveViewFrame.onload = null; // Reset previous listeners
    liveViewFrame.onerror = null;
    liveViewFrame.onload = () => { console.log("Live view iframe loaded successfully."); hideLiveViewStatus(); };
    liveViewFrame.onerror = (e) => { console.error("Live view iframe failed to load:", e); showLiveViewStatus("VNC Load Error - Check Port 6080 & Docker Setup"); };
}
function showLiveViewStatus(text) { liveViewStatus.textContent = text; liveViewStatus.classList.add('visible'); }
function hideLiveViewStatus() { liveViewStatus.classList.remove('visible'); }


// --- Task List Rendering ---
function renderTaskList(tasks) {
    // tasks should be an array of objects like: { description: "...", status: "pending|running|done|error" }
    if (!Array.isArray(tasks)) {
        console.error("Invalid task data for rendering:", tasks);
        taskListDiv.innerHTML = '<p class="message agent-error">Error: Received invalid task data.</p>';
        return;
    }

    if (tasks.length === 0) {
        taskListDiv.innerHTML = '<p class="message agent-activity">No tasks defined for this request.</p>';
        return;
    }

    // Clear previous list
    taskListDiv.innerHTML = '';

    const listElement = document.createElement('ol'); // Use ordered list for steps

    tasks.forEach(task => {
        const listItem = document.createElement('li');
        // Sanitize description text before setting
        const descriptionNode = document.createTextNode(task.description || 'Unnamed Task');
        listItem.appendChild(descriptionNode);

        // Add status class (ensure status exists and is lowercase)
        const status = (task.status || 'pending').toLowerCase();
        listItem.className = `status-${status}`; // Use className to overwrite previous states

        listElement.appendChild(listItem);
    });

    taskListDiv.appendChild(listElement);
    // Optional: Scroll to bottom if list becomes long
    // taskListDiv.scrollTop = taskListDiv.scrollHeight;
}


// --- Message Sending ---
function sendMessage() {
    const messageText = userInput.value.trim();
    const selectedModel = modelSelect.value || "llama3:latest"; // Fallback model

    if (messageText && socket && socket.readyState === WebSocket.OPEN) {
        console.log(`Sending message: '${messageText}' using model: ${selectedModel}`);
        clearInitialMessages();

        const selectedModelText = modelSelect.options[modelSelect.selectedIndex]?.text || selectedModel;
        appendMessage(chatHistory, `You (${selectedModelText}): ${messageText}`, 'user');

        const messagePayload = JSON.stringify({ query: messageText, model: selectedModel });
        socket.send(messagePayload);

        userInput.value = '';
        userInput.rows = 3;
        // Reset task list display for the new request
        taskListDiv.innerHTML = '<p class="message agent-activity">Agent is planning tasks...</p>';
        // Optionally add a "Processing..." message to chat history
        appendMessage(chatHistory, 'Agent: Processing request...', 'agent-activity');

    } else if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error('WebSocket is not connected.');
        appendMessage(chatHistory, 'Error: Not connected to agent backend. Cannot send message.', 'agent-error');
        showLiveViewStatus("Disconnected - Cannot Send");
    } else if (!messageText) {
         console.log('No message text entered.');
    }
}

// --- Utility to Append Messages to Chat History ---
function appendMessage(container, text, type) {
    if (!container) { console.error("Append message target container is null"); return; }
    const initialPlaceholders = ["Connecting to agent...", "Waiting for connection...", "Welcome! Select a model and enter your query."];
    if (container === chatHistory && container.children.length === 1 && initialPlaceholders.some(msg => container.firstElementChild.textContent.includes(msg))) {
        container.innerHTML = '';
    }

    const messageElement = document.createElement('p');
    messageElement.classList.add('message', type);

    // Escape HTML, then apply formatting
    let formattedText = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    formattedText = formattedText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'); // Bold
    // Basic code block handling (assumes ``` block is on its own lines or correctly formatted)
    formattedText = formattedText.replace(/```(\w*?)<br>([\s\S]*?)<br>```/g, (match, lang, code) => {
         const codeContent = code.replace(/<br>/g, '\n'); // Convert <br> back to newline for pre/code
         const escapedCode = codeContent.replace(/</g, "&lt;").replace(/>/g, "&gt;"); // Escape inside code
         return `<pre><code class="language-${lang || 'plaintext'}">${escapedCode.trim()}</code></pre>`;
    });
     // Handle potential single-line code blocks ```code``` (less common)
     formattedText = formattedText.replace(/```(.*?)```/g, (match, code) => `<code>${code.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`);
    formattedText = formattedText.replace(/\n/g, '<br>'); // Convert remaining newlines

    messageElement.innerHTML = formattedText;
    container.appendChild(messageElement);
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}

// --- Event Listeners ---
sendButton.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault(); sendMessage();
    }
});
userInput.addEventListener('input', () => {
    const textarea = userInput; textarea.style.height = 'auto';
    const requiredHeight = textarea.scrollHeight;
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight);
    const requiredRows = Math.ceil(requiredHeight / lineHeight);
    const newRows = Math.max(3, Math.min(requiredRows || 1, 10)); // Ensure at least 1 row calculation, apply limits
    textarea.rows = newRows; // Adjust rows attribute
    // Or set height directly: textarea.style.height = `${Math.max(lineHeight * 3, Math.min(requiredHeight, lineHeight * 10))}px`;
});

// --- Initial Connection ---
connectWebSocket(); // Start the connection process