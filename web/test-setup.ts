// jsdom has <dialog> but neither opens nor closes one.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
// Nor does it lay anything out, so it has nothing to scroll into view.
Element.prototype.scrollIntoView = function scrollIntoView() {};
