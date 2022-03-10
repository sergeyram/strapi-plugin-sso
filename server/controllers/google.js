const axios = require("axios");
const {v4} = require('uuid');
const strapiUtils = require('@strapi/utils');
const {getService} = require("@strapi/admin/server/utils");

/**
 * Common constants
 */
const OAUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/auth'
const OAUTH_TOKEN_ENDPOINT = 'https://accounts.google.com/o/oauth2/token'
const OAUTH_USER_INFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v1/userinfo'
const OAUTH_GRANT_TYPE = 'authorization_code'
const OAUTH_RESPONSE_TYPE = 'code'

/**
 * Redirect to Google
 * @param ctx
 * @return {Promise<*>}
 */
async function googleSignIn(ctx) {
  const redirectUri = encodeURIComponent(process.env.GOOGLE_OAUTH_REDIRECT_URI)
  const scope = encodeURIComponent(process.env.GOOGLE_OAUTH_SCOPE)
  const url = `${OAUTH_ENDPOINT}?client_id=${process.env.GOOGLE_OAUTH_CLIENT_ID}&redirect_uri=${redirectUri}&scope=${scope}&response_type=${OAUTH_RESPONSE_TYPE}`
  ctx.set('Location', url)
  return ctx.send({}, 301)
}

/**
 * Verify the token and if there is no account, create one and then log in
 * @param ctx
 * @return {Promise<*>}
 */
async function googleSignInCallback(ctx) {
  const httpClient = axios.create()
  const tokenService = getService('token')
  const userService = getService('user')
  const oauthService = strapi.plugin('strapi-plugin-sso').service('oauth')
  const roleService = strapi.plugin('strapi-plugin-sso').service('role')

  if (!ctx.query.code) {
    return ctx.send(oauthService.renderSignUpError(`code Not Found`))
  }

  const params = new URLSearchParams();
  params.append('code', ctx.query.code);
  params.append('client_id', process.env.GOOGLE_OAUTH_CLIENT_ID);
  params.append('client_secret', process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  params.append('redirect_uri', process.env.GOOGLE_OAUTH_REDIRECT_URI);
  params.append('grant_type', OAUTH_GRANT_TYPE);

  try {
    const response = await httpClient.post(OAUTH_TOKEN_ENDPOINT, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })
    const userInfoEndpoint = `${OAUTH_USER_INFO_ENDPOINT}?access_token=${response.data.access_token}`
    const userResponse = await httpClient.get(userInfoEndpoint)

    // for GSuite
    if (process.env.GOOGLE_GSUITE_HD) {
      if (userResponse.data.hd !== process.env.GOOGLE_GSUITE_HD) {
        throw new Error('Unauthorized email address')
      }
    }

    const email = process.env.GOOGLE_ALIAS ? oauthService.addGmailAlias(userResponse.data.email, process.env.GOOGLE_ALIAS) : userResponse.data.email
    const dbUser = await userService.findOneByEmail(email)
    let activateUser;
    let jwtToken;

    if (dbUser) {
      // Already registered
      activateUser = dbUser;
      jwtToken = await tokenService.createJwtToken(dbUser)
    } else {
      // Register a new account
      const googleRoles = await roleService.googleRoles()
      const roles = googleRoles && googleRoles['roles'] ? googleRoles['roles'].map(role => ({
        id: role
      })) : []

      const defaultLocale = oauthService.localeFindByHeader(ctx.request.headers)
      activateUser = await oauthService.createUser(
        email,
        userResponse.data.family_name,
        userResponse.data.given_name,
        defaultLocale,
        roles
      )
      jwtToken = await tokenService.createJwtToken(activateUser)


      // Trigger webhook
      const {ENTRY_CREATE} = strapiUtils.webhook.webhookEvents;
      const modelDef = strapi.getModel('admin::user');
      const sanitizedEntity = await strapiUtils.sanitize.sanitizers.defaultSanitizeOutput(
        modelDef,
        activateUser
      );
      strapi.eventHub.emit(ENTRY_CREATE, {
        model: modelDef.modelName,
        entry: sanitizedEntity,
      });
    }

    // Client-side authentication persistence and redirection
    const nonce = v4()
    const html = oauthService.renderSignUpSuccess(jwtToken, activateUser, nonce)
    ctx.set('Content-Security-Policy', `script-src 'nonce-${nonce}'`)
    ctx.send(html);
  } catch (e) {
    console.error(e)
    ctx.send(oauthService.renderSignUpError(e.message))
  }
}

module.exports = {
  googleSignIn,
  googleSignInCallback
}
