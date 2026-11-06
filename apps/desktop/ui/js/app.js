// Entry point: restore preferences and render the initial state.
// Settings first: they provide the startup model/mode/speed and the history size.
ANB.settings
  .load()
  .catch(() => ({}))
  .then((values) => {
    ANB.composer.init(values);
    ANB.chat.restore();
    ANB.chat.renderHistory();
    ANB.composer.update();
  });
