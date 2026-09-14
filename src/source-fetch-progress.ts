export interface SourceFetchProgress {
  start(message: string): void;
  message(message: string): void;
  stop(message: string): void;
}
