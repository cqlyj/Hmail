(function () {
  "use strict";
  var H = window.Hmail;
  var prompt = H.setupPrompt();
  document.getElementById("setup-prompt").textContent = prompt;
  document.getElementById("copy-setup").addEventListener("click", function () {
    H.copy(prompt, "Setup prompt copied");
  });
})();
