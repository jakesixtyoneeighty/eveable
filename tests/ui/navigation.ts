export function useRouter() {
  return {
    push: (path: string) => {
      window.history.pushState({}, "", path);
    },
  };
}
