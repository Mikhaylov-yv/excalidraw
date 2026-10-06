import {
  isSavedToFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "./firebase";
import {
  isSavedToHttpStorage,
  loadFilesFromHttpStorage,
  loadFromHttpStorage,
  saveFilesToHttpStorage,
  saveToHttpStorage,
} from "./httpStorage";

// Collab scenes and files are stored in Firebase, unless the app is built
// with VITE_APP_STORAGE_BACKEND_URL (self-hosting), in which case they're
// stored on that HTTP backend instead.
const IS_HTTP_STORAGE = !!import.meta.env.VITE_APP_STORAGE_BACKEND_URL;

export const isSavedToStorage: typeof isSavedToFirebase = (...args) =>
  IS_HTTP_STORAGE ? isSavedToHttpStorage(...args) : isSavedToFirebase(...args);

export const saveToStorage: typeof saveToFirebase = (...args) =>
  IS_HTTP_STORAGE ? saveToHttpStorage(...args) : saveToFirebase(...args);

export const loadFromStorage: typeof loadFromFirebase = (...args) =>
  IS_HTTP_STORAGE ? loadFromHttpStorage(...args) : loadFromFirebase(...args);

export const saveFilesToStorage: typeof saveFilesToFirebase = (...args) =>
  IS_HTTP_STORAGE
    ? saveFilesToHttpStorage(...args)
    : saveFilesToFirebase(...args);

export const loadFilesFromStorage: typeof loadFilesFromFirebase = (...args) =>
  IS_HTTP_STORAGE
    ? loadFilesFromHttpStorage(...args)
    : loadFilesFromFirebase(...args);
