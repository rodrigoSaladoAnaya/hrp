export type RegistrationInput = {
  email: string;
  password: string;
  displayName: string;
};

export type RegisteredUser = {
  id: string;
  email: string;
  displayName: string;
};

export function registerUser(input: RegistrationInput): RegisteredUser {
  return {
    id: `usr_${Date.now()}`,
    email: input.email.trim().toLowerCase(),
    displayName: input.displayName.trim(),
  };
}

