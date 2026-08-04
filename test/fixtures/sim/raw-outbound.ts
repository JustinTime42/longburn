declare const send: (message: string) => void;

send("this deliberately bypasses the causal emission gate");
