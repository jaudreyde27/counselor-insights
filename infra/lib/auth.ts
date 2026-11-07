import { RemovalPolicy } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

/**
 * Cognito (SPEC.md section 8): a user pool where ONLY an administrator creates users (no self sign-up),
 * email and password, no MFA for the prototype, and Managed Login (the hosted sign-in page). The app
 * client is a public client using the authorization code flow with PKCE, so there is no client secret.
 * Users are created in the Cognito console (see docs/AWS_SETUP.md).
 */
export class Auth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: { appHostname: string; domainPrefix: string }) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, "Pool", {
      selfSignUpEnabled: false, // administrators create every account
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: false } },
      autoVerify: { email: true },
      mfa: cognito.Mfa.OFF,
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.domain = this.userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: props.domainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    this.client = this.userPool.addClient("App", {
      generateSecret: false,
      authFlows: {}, // sign-in only through the hosted page
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://${props.appHostname}/auth/callback`, "http://localhost:3000/auth/callback"],
        logoutUrls: [`https://${props.appHostname}/login`, "http://localhost:3000/login"],
      },
    });

    // Managed Login needs a "branding" style to render; Cognito's own default look is used.
    new cognito.CfnManagedLoginBranding(this, "Branding", {
      userPoolId: this.userPool.userPoolId,
      clientId: this.client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
  }
}
