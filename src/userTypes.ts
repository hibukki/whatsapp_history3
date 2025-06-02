import { User as FirebaseUser } from 'firebase/auth';

export interface LocalUser {
  uid: string;
  displayName: string;
  email: string;
  isLocal: true;
}

export interface FirebaseUserWrapper {
  uid: string;
  displayName: string | null;
  email: string | null;
  isLocal: false;
  firebaseUser: FirebaseUser;
}

export type AppUser = LocalUser | FirebaseUserWrapper;

export function createLocalUser(displayName: string): LocalUser {
  return {
    uid: 'local-user-' + Date.now(),
    displayName,
    email: 'local@user.local',
    isLocal: true
  };
}

export function wrapFirebaseUser(firebaseUser: FirebaseUser): FirebaseUserWrapper {
  return {
    uid: firebaseUser.uid,
    displayName: firebaseUser.displayName,
    email: firebaseUser.email,
    isLocal: false,
    firebaseUser
  };
}

export function isLocalUser(user: AppUser): user is LocalUser {
  return user.isLocal === true;
}

export function isFirebaseUser(user: AppUser): user is FirebaseUserWrapper {
  return user.isLocal === false;
}