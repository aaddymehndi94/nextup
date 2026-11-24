import java.util.Properties

plugins {
    id("com.android.application")
}

// The TV app carries nexttupp's version (root package.json): 0.5.8 is versionCode 508.
val appVersion: String = Regex("\"version\":\\s*\"([0-9.]+)\"")
    .find(rootDir.resolve("../package.json").readText())!!.groupValues[1]
val (major, minor, patch) = appVersion.split(".").map { it.toInt() }

// The release key never enters the repo (it's public). Its properties file (storeFile, storePassword, keyAlias,
// keyPassword) lives on the build computer, at ~/.config/nexttupp-release/tv-signing.properties or $NEXTTUPP_TV_SIGNING.
// Losing the key means TVs can't update the app in place: back it up.
val signing = Properties().apply {
    val f = file(System.getenv("NEXTTUPP_TV_SIGNING") ?: "${System.getProperty("user.home")}/.config/nexttupp-release/tv-signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.nexttupp.tv"
    compileSdk = 36

    defaultConfig {
        // Permanent: Android ties updates (and, from 2027, developer verification) to this id and the signing key.
        applicationId = "com.nexttupp.tv"
        minSdk = 24
        targetSdk = 36
        versionCode = major * 10000 + minor * 100 + patch
        versionName = appVersion
    }

    signingConfigs {
        if (signing.containsKey("storeFile")) create("release") {
            storeFile = file(signing.getProperty("storeFile"))
            storePassword = signing.getProperty("storePassword")
            keyAlias = signing.getProperty("keyAlias")
            keyPassword = signing.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
