// Parser-blocking loading preserves the original DOMContentLoaded initialization.
// Both paths are fixed local assets, never taken from URL/user input.
document.write('<script src="' + (isTV ? 'app-tv.js' : 'app.js') + '?v=8.1"><\/script>');
